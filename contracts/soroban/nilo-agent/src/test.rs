extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env,
};

/// Minimal XOXNO: supply pulls from the caller into the pool, withdraw pays `to`.
#[contract]
struct MockXoxno;

#[contractimpl]
impl MockXoxno {
    pub fn init(env: Env, usdc: Address, pool: Address) {
        env.storage().instance().set(&0u32, &(usdc, pool));
    }
    pub fn supply(env: Env, caller: Address, account_id: u64, _spoke_id: u32, assets: Vec<(HubAssetKey, i128)>) -> u64 {
        caller.require_auth();
        let (usdc, pool): (Address, Address) = env.storage().instance().get(&0u32).unwrap();
        let (_, amount) = assets.get(0).unwrap();
        TokenClient::new(&env, &usdc).transfer(&caller, &pool, &amount);
        // Like XOXNO: supplying to a closed account fails; 0 opens the next id.
        let id = if account_id == 0 {
            let next: u64 = env.storage().instance().get(&9u32).unwrap_or(131);
            env.storage().instance().set(&9u32, &(next + 1));
            next
        } else {
            assert!(env.storage().instance().has(&account_id), "account closed");
            account_id
        };
        let held: i128 = env.storage().instance().get(&id).unwrap_or(0);
        env.storage().instance().set(&id, &(held + amount));
        id
    }
    pub fn withdraw(
        env: Env,
        caller: Address,
        account_id: u64,
        withdrawals: Vec<(HubAssetKey, i128)>,
        to: Option<Address>,
    ) -> Vec<(HubAssetKey, i128)> {
        caller.require_auth();
        let (usdc, pool): (Address, Address) = env.storage().instance().get(&0u32).unwrap();
        let (key, asked) = withdrawals.get(0).unwrap();
        let held: i128 = env.storage().instance().get(&account_id).unwrap_or(0);
        let amount = if asked == 0 { held } else { asked };
        if held - amount == 0 {
            env.storage().instance().remove(&account_id);
        } else {
            env.storage().instance().set(&account_id, &(held - amount));
        }
        TokenClient::new(&env, &usdc).transfer(&pool, &to.unwrap_or(caller), &amount);
        vec![&env, (key, amount)]
    }
    pub fn account_exists(env: Env, account_id: u64) -> bool {
        env.storage().instance().has(&account_id)
    }
    pub fn renew_account(_env: Env, caller: Address, _account_id: u64) {
        caller.require_auth();
    }
    pub fn get_collateral_amount(env: Env, account_id: u64, _hub_asset: HubAssetKey) -> i128 {
        env.storage().instance().get(&account_id).unwrap_or(0)
    }
    pub fn get_pool_address(env: Env) -> Address {
        let (_, pool): (Address, Address) = env.storage().instance().get(&0u32).unwrap();
        pool
    }
}

/// Minimal CCTP messenger: pulls the burn with transfer_from and records the hook data.
#[contract]
struct MockMessenger;

#[contractimpl]
impl MockMessenger {
    pub fn init(env: Env, usdc: Address) {
        env.storage().instance().set(&0u32, &usdc);
    }
    #[allow(clippy::too_many_arguments)]
    pub fn deposit_for_burn_with_hook(
        env: Env,
        caller: Address,
        amount: i128,
        _destination_domain: u32,
        _mint_recipient: BytesN<32>,
        _burn_token: Address,
        _destination_caller: BytesN<32>,
        _max_fee: i128,
        _min_finality_threshold: u32,
        hook_data: Bytes,
    ) {
        caller.require_auth();
        let usdc: Address = env.storage().instance().get(&0u32).unwrap();
        let this = env.current_contract_address();
        TokenClient::new(&env, &usdc).transfer_from(&this, &caller, &this, &amount);
        env.storage().instance().set(&1u32, &hook_data);
    }
    pub fn last_hook(env: Env) -> Bytes {
        env.storage().instance().get(&1u32).unwrap()
    }
}

struct Setup {
    env: Env,
    agent: NiloAgentClient<'static>,
    usdc: TokenClient<'static>,
    user: Address,
    operator: Address,
    pool: Address,
    messenger: Address,
}

const USDC: i128 = 10_000_000;

fn setup() -> Setup {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.timestamp = 1_000_000;
        l.sequence_number = 100;
    });
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let usdc_id = sac.address();
    let user = Address::generate(&env);
    let operator = Address::generate(&env);
    let pool = Address::generate(&env);
    env.mock_all_auths();
    StellarAssetClient::new(&env, &usdc_id).mint(&user, &(1_000 * USDC));

    let xoxno = env.register(MockXoxno, ());
    MockXoxnoClient::new(&env, &xoxno).init(&usdc_id, &pool);
    let messenger = env.register(MockMessenger, ());
    MockMessengerClient::new(&env, &messenger).init(&usdc_id);

    let config = Config {
        operator: operator.clone(),
        usdc: usdc_id.clone(),
        xoxno,
        hub_id: 1,
        spoke_id: 1,
        messenger: messenger.clone(),
        dest_domain: 3,
        vault: BytesN::from_array(&env, &[7; 32]),
    };
    let agent_id = env.register(NiloAgent, (config,));
    let agent = NiloAgentClient::new(&env, &agent_id);
    let usdc = TokenClient::new(&env, &usdc_id);
    // Leak the env into 'static clients for the test's lifetime.
    let env_static: &'static Env = std::boxed::Box::leak(std::boxed::Box::new(env.clone()));
    Setup {
        env,
        agent: NiloAgentClient::new(env_static, &agent.address),
        usdc: TokenClient::new(env_static, &usdc.address),
        user,
        operator,
        pool,
        messenger,
    }
}

fn mandate(env: &Env, venues: u32) -> Mandate {
    Mandate { limit: 100 * USDC, period: 7 * 86_400, expires_at: 1_000_000 + 30 * 86_400, venues, profile: Symbol::new(env, "balanced") }
}

/// Only the operator's root call is authorized; everything else must come from the contract itself.
fn invest_as_operator(s: &Setup, venue: u32, amount: i128) {
    s.env.mock_auths(&[MockAuth {
        address: &s.operator,
        invoke: &MockAuthInvoke {
            contract: &s.agent.address,
            fn_name: "invest",
            args: (s.user.clone(), venue, amount).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.agent.invest(&s.user, &venue, &amount);
}

#[test]
fn invests_into_xoxno_within_the_mandate() {
    let s = setup();
    s.agent.set_mandate(&s.user, &mandate(&s.env, VENUE_XOXNO), &(400 * USDC), &5_000);
    assert_eq!(s.usdc.allowance(&s.user, &s.agent.address), 400 * USDC);

    invest_as_operator(&s, VENUE_XOXNO, 60 * USDC);
    assert_eq!(s.usdc.balance(&s.pool), 60 * USDC);
    assert_eq!(s.usdc.balance(&s.agent.address), 0);
    let position = s.agent.position(&s.user);
    assert_eq!(position.xoxno_account, 131);
    assert_eq!(position.xoxno_principal, 60 * USDC);
    assert_eq!(s.agent.xoxno_balance(&s.user), 60 * USDC);
    assert_eq!(s.agent.usage(&s.user).spent, 60 * USDC);

    // A second supply reuses the same XOXNO account.
    invest_as_operator(&s, VENUE_XOXNO, 10 * USDC);
    assert_eq!(s.agent.position(&s.user).xoxno_account, 131);
    assert_eq!(s.agent.xoxno_balance(&s.user), 70 * USDC);
}

#[test]
fn bridges_with_the_user_as_beneficiary() {
    let s = setup();
    s.agent.set_mandate(&s.user, &mandate(&s.env, VENUE_XOXNO | VENUE_AAVE_ARBITRUM), &(400 * USDC), &5_000);
    invest_as_operator(&s, VENUE_AAVE_ARBITRUM, 40 * USDC);
    assert_eq!(s.usdc.balance(&s.messenger), 40 * USDC);
    assert_eq!(s.agent.position(&s.user).bridged, 40 * USDC);
    let hook = MockMessengerClient::new(&s.env, &s.messenger).last_hook();
    let strkey = s.user.to_string();
    let mut expected = [0u8; 56];
    strkey.copy_into_slice(&mut expected);
    assert_eq!(hook, Bytes::from_array(&s.env, &expected));
}

#[test]
fn enforces_the_period_limit_and_resets_it() {
    let s = setup();
    s.agent.set_mandate(&s.user, &mandate(&s.env, VENUE_XOXNO), &(1_000 * USDC), &50_000);
    invest_as_operator(&s, VENUE_XOXNO, 100 * USDC);
    s.env.mock_all_auths();
    assert_eq!(s.agent.try_invest(&s.user, &VENUE_XOXNO, &1), Err(Ok(Error::OverLimit.into())));
    s.env.ledger().with_mut(|l| l.timestamp += 7 * 86_400);
    invest_as_operator(&s, VENUE_XOXNO, 100 * USDC);
    assert_eq!(s.agent.position(&s.user).xoxno_principal, 200 * USDC);
}

#[test]
fn refuses_venues_outside_the_mandate_expired_or_revoked() {
    let s = setup();
    s.env.mock_all_auths();
    assert_eq!(s.agent.try_invest(&s.user, &VENUE_XOXNO, &USDC), Err(Ok(Error::NoMandate.into())));
    s.agent.set_mandate(&s.user, &mandate(&s.env, VENUE_XOXNO), &(400 * USDC), &5_000);
    assert_eq!(s.agent.try_invest(&s.user, &VENUE_AAVE_ARBITRUM, &USDC), Err(Ok(Error::VenueNotAllowed.into())));
    assert_eq!(s.agent.try_invest(&s.user, &4, &USDC), Err(Ok(Error::VenueNotAllowed.into())));
    assert_eq!(s.agent.try_invest(&s.user, &VENUE_XOXNO, &0), Err(Ok(Error::BadAmount.into())));

    s.env.ledger().with_mut(|l| l.timestamp += 31 * 86_400);
    assert_eq!(s.agent.try_invest(&s.user, &VENUE_XOXNO, &USDC), Err(Ok(Error::Expired.into())));

    s.env.ledger().with_mut(|l| l.timestamp -= 31 * 86_400);
    s.agent.revoke(&s.user);
    assert_eq!(s.usdc.allowance(&s.user, &s.agent.address), 0);
    assert_eq!(s.agent.mandate(&s.user), None);
    assert_eq!(s.agent.try_invest(&s.user, &VENUE_XOXNO, &USDC), Err(Ok(Error::NoMandate.into())));
}

#[test]
fn only_the_operator_can_invest() {
    let s = setup();
    s.agent.set_mandate(&s.user, &mandate(&s.env, VENUE_XOXNO), &(400 * USDC), &5_000);
    let stranger = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.agent.address,
            fn_name: "invest",
            args: (s.user.clone(), VENUE_XOXNO, USDC).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.agent.try_invest(&s.user, &VENUE_XOXNO, &USDC).is_err());
}

#[test]
fn withdrawals_always_pay_the_user() {
    let s = setup();
    s.agent.set_mandate(&s.user, &mandate(&s.env, VENUE_XOXNO), &(400 * USDC), &5_000);
    invest_as_operator(&s, VENUE_XOXNO, 50 * USDC);
    let before = s.usdc.balance(&s.user);

    // The mock pool is a plain address that must authorize its payout; XOXNO's real pool is a contract.
    s.env.mock_all_auths_allowing_non_root_auth();
    assert_eq!(s.agent.withdraw(&s.operator, &s.user, &(20 * USDC)), 20 * USDC);
    assert_eq!(s.usdc.balance(&s.user), before + 20 * USDC);
    assert_eq!(s.usdc.balance(&s.operator), 0);
    assert_eq!(s.agent.position(&s.user).xoxno_principal, 30 * USDC);

    assert_eq!(s.agent.withdraw(&s.user, &s.user, &0), 30 * USDC);
    assert_eq!(s.usdc.balance(&s.user), before + 50 * USDC);
    assert_eq!(s.agent.position(&s.user).xoxno_principal, 0);

    let stranger = Address::generate(&s.env);
    assert_eq!(s.agent.try_withdraw(&stranger, &s.user, &1), Err(Ok(Error::NotAllowed.into())));
}

#[test]
fn rejects_bad_mandates_and_dusty_bridges() {
    let s = setup();
    s.env.mock_all_auths();
    let mut m = mandate(&s.env, VENUE_XOXNO);
    m.limit = 0;
    assert_eq!(s.agent.try_set_mandate(&s.user, &m, &USDC, &5_000), Err(Ok(Error::BadMandate.into())));
    let mut m = mandate(&s.env, 8);
    m.venues = 8;
    assert_eq!(s.agent.try_set_mandate(&s.user, &m, &USDC, &5_000), Err(Ok(Error::BadMandate.into())));
    let mut m = mandate(&s.env, VENUE_XOXNO);
    m.expires_at = 1;
    assert_eq!(s.agent.try_set_mandate(&s.user, &m, &USDC, &5_000), Err(Ok(Error::BadMandate.into())));

    s.agent.set_mandate(&s.user, &mandate(&s.env, VENUE_AAVE_ARBITRUM), &(400 * USDC), &5_000);
    assert_eq!(s.agent.try_invest(&s.user, &VENUE_AAVE_ARBITRUM, &(USDC + 3)), Err(Ok(Error::BadAmount.into())));
}

#[test]
fn reinvests_after_xoxno_closed_the_emptied_account() {
    let s = setup();
    s.agent.set_mandate(&s.user, &mandate(&s.env, VENUE_XOXNO), &(400 * USDC), &5_000);
    invest_as_operator(&s, VENUE_XOXNO, 10 * USDC);
    assert_eq!(s.agent.position(&s.user).xoxno_account, 131);

    s.env.mock_all_auths_allowing_non_root_auth();
    s.agent.withdraw(&s.user, &s.user, &0);
    assert_eq!(s.agent.position(&s.user).xoxno_account, 0);

    invest_as_operator(&s, VENUE_XOXNO, 5 * USDC);
    let position = s.agent.position(&s.user);
    assert_eq!(position.xoxno_account, 132);
    assert_eq!(position.xoxno_principal, 5 * USDC);
}

#[test]
fn opens_a_new_account_when_the_stored_one_is_gone() {
    let s = setup();
    s.agent.set_mandate(&s.user, &mandate(&s.env, VENUE_XOXNO), &(400 * USDC), &5_000);
    invest_as_operator(&s, VENUE_XOXNO, 10 * USDC);
    // XOXNO closed it behind our back (for example a withdrawal straight on XOXNO).
    s.env.as_contract(&s.agent.config().xoxno, || s.env.storage().instance().remove(&131u64));
    invest_as_operator(&s, VENUE_XOXNO, 5 * USDC);
    assert_eq!(s.agent.position(&s.user).xoxno_account, 132);
}
