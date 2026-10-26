#![no_std]
//! NiloAgent: lets Nilo's agent invest a user's USDC while they sleep, without
//! ever holding the user's key. The user signs a mandate once (caps, venues,
//! expiry) and an allowance to this contract. Nilo's operator key can then only
//! move that USDC into the allowed venues, inside the caps: XOXNO Lending on
//! Stellar, or the user's own wallet on another chain through Circle CCTP.
//! Withdrawals only ever pay the user. The user can revoke at any time.

mod venues;
#[cfg(test)]
mod test;

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token, vec, Address, Bytes,
    BytesN, Env, IntoVal, Symbol, Vec,
};
pub use venues::HubAssetKey;
use venues::{TokenMessengerClient, XoxnoClient};

/// Venue bits in `Mandate::venues`.
pub const VENUE_XOXNO: u32 = 1;
/// USDC delivered by Circle CCTP to the user's own wallet on the destination chain.
pub const VENUE_CROSSCHAIN: u32 = 2;
const ALL_VENUES: u32 = VENUE_XOXNO | VENUE_CROSSCHAIN;

/// CCTP Standard transfer; Stellar sources only support this tier.
const CCTP_FINALITY_STANDARD: u32 = 2000;
/// Hook data that asks Circle's Forwarding Service to finish the mint on the
/// destination and pay its gas, taking its fee from the minted USDC: "cctp-forward", zero-padded.
const CCTP_FORWARD: [u8; 32] = *b"cctp-forward\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";
const MIN_PERIOD_SECONDS: u64 = 60;

const DAY_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_LEDGERS;
const TTL_EXTEND_TO: u32 = 120 * DAY_LEDGERS;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// Nilo's agent key. It can only call `invest`, `withdraw` and `renew`.
    pub operator: Address,
    pub usdc: Address,
    pub xoxno: Address,
    pub hub_id: u32,
    pub spoke_id: u32,
    pub messenger: Address,
    pub dest_domain: u32,
    /// Most the operator may let Circle's forwarder take per transfer (USDC, 7 decimals).
    pub max_bridge_fee: i128,
}

/// What the user lets the agent do. Signed by the user once.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Mandate {
    /// Most USDC (7 decimals) the agent may invest per period.
    pub limit: i128,
    pub period: u64,
    /// Unix seconds after which the agent can no longer invest.
    pub expires_at: u64,
    /// Bitmask of allowed venues (`VENUE_*`).
    pub venues: u32,
    /// The personality the user chose, for display.
    pub profile: Symbol,
    /// The user's own wallet on the destination chain (CCTP 32-byte form). Needed for `VENUE_CROSSCHAIN`.
    pub evm_recipient: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Usage {
    pub period_start: u64,
    pub spent: i128,
}

/// What the agent has invested for a user so far.
#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Position {
    /// The user's XOXNO account, owned by this contract (0 until the first supply).
    pub xoxno_account: u64,
    /// USDC supplied to XOXNO and not yet withdrawn.
    pub xoxno_principal: i128,
    /// USDC sent to the user's wallet on the destination chain, fees included.
    pub bridged: i128,
}

#[contracttype]
enum DataKey {
    Config,
    Mandate(Address),
    Usage(Address),
    Position(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NoMandate = 1,
    Expired = 2,
    VenueNotAllowed = 3,
    OverLimit = 4,
    BadAmount = 5,
    BadMandate = 6,
    NoPosition = 7,
    NotAllowed = 8,
}

#[contract]
pub struct NiloAgent;

#[contractimpl]
impl NiloAgent {
    pub fn __constructor(env: Env, config: Config) {
        env.storage().instance().set(&DataKey::Config, &config);
    }

    pub fn config(env: Env) -> Config {
        config(&env)
    }

    /// Sets (or replaces) the user's mandate and the USDC allowance the agent can draw from.
    pub fn set_mandate(env: Env, user: Address, mandate: Mandate, allowance: i128, allowance_ledger: u32) {
        user.require_auth();
        let now = env.ledger().timestamp();
        if mandate.limit <= 0
            || mandate.period < MIN_PERIOD_SECONDS
            || mandate.expires_at <= now
            || mandate.venues == 0
            || mandate.venues & !ALL_VENUES != 0
            || allowance < 0
            || (mandate.venues & VENUE_CROSSCHAIN != 0 && mandate.evm_recipient.is_none())
        {
            panic_with_error!(&env, Error::BadMandate);
        }
        let cfg = config(&env);
        token::TokenClient::new(&env, &cfg.usdc).approve(&user, &env.current_contract_address(), &allowance, &allowance_ledger);
        put(&env, &DataKey::Mandate(user.clone()), &mandate);
        put(&env, &DataKey::Usage(user.clone()), &Usage { period_start: now, spent: 0 });
        #[allow(deprecated)]
        env.events().publish((symbol_short!("mandate"), user), (mandate.limit, mandate.period, mandate.expires_at, mandate.venues));
    }

    /// Ends the mandate and sets the allowance to zero. Existing positions stay withdrawable.
    pub fn revoke(env: Env, user: Address) {
        user.require_auth();
        let cfg = config(&env);
        // A fixed expiry: the user's signature covers these arguments, and the ledger moves between simulation and execution.
        token::TokenClient::new(&env, &cfg.usdc).approve(&user, &env.current_contract_address(), &0, &0);
        env.storage().persistent().remove(&DataKey::Mandate(user.clone()));
        env.storage().persistent().remove(&DataKey::Usage(user.clone()));
        #[allow(deprecated)]
        env.events().publish((symbol_short!("revoke"), user), ());
    }

    /// Called by Nilo's agent: moves `amount` of the user's USDC into one venue, within the mandate.
    /// `max_fee` is what Circle's forwarder may keep on a cross-chain move (0 for XOXNO).
    pub fn invest(env: Env, user: Address, venue: u32, amount: i128, max_fee: i128) {
        let cfg = config(&env);
        cfg.operator.require_auth();
        if amount <= 0 || max_fee < 0 || (venue == VENUE_XOXNO && max_fee != 0) {
            panic_with_error!(&env, Error::BadAmount);
        }
        let mandate: Mandate = get(&env, &DataKey::Mandate(user.clone())).unwrap_or_else(|| panic_with_error!(&env, Error::NoMandate));
        let now = env.ledger().timestamp();
        if now >= mandate.expires_at {
            panic_with_error!(&env, Error::Expired);
        }
        if (venue != VENUE_XOXNO && venue != VENUE_CROSSCHAIN) || mandate.venues & venue == 0 {
            panic_with_error!(&env, Error::VenueNotAllowed);
        }
        let mut usage: Usage = get(&env, &DataKey::Usage(user.clone())).unwrap_or_default();
        if now >= usage.period_start + mandate.period {
            usage = Usage { period_start: now, spent: 0 };
        }
        if usage.spent + amount > mandate.limit {
            panic_with_error!(&env, Error::OverLimit);
        }
        usage.spent += amount;
        put(&env, &DataKey::Usage(user.clone()), &usage);

        let this = env.current_contract_address();
        let usdc = token::TokenClient::new(&env, &cfg.usdc);
        usdc.transfer_from(&this, &user, &this, &amount);

        let mut position: Position = get(&env, &DataKey::Position(user.clone())).unwrap_or_default();
        if venue == VENUE_XOXNO {
            let xoxno = XoxnoClient::new(&env, &cfg.xoxno);
            // XOXNO closes an account once it is emptied; open a new one then.
            if position.xoxno_account != 0 && !xoxno.account_exists(&position.xoxno_account) {
                position.xoxno_account = 0;
            }
            let pool = xoxno.get_pool_address();
            // The authorization below covers only the next call this contract makes, so nothing may come between.
            // XOXNO pulls the USDC from its caller (this contract) inside `supply`.
            env.authorize_as_current_contract(vec![
                &env,
                InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: cfg.usdc.clone(),
                        fn_name: Symbol::new(&env, "transfer"),
                        args: (this.clone(), pool, amount).into_val(&env),
                    },
                    sub_invocations: vec![&env],
                }),
            ]);
            let key = HubAssetKey { asset: cfg.usdc.clone(), hub_id: cfg.hub_id };
            position.xoxno_account =
                xoxno.supply(&this, &position.xoxno_account, &cfg.spoke_id, &vec![&env, (key, amount)]);
            position.xoxno_principal += amount;
        } else {
            // CCTP moves 6 decimals; refuse amounts that would leave dust here. The fee cap stops the
            // operator from handing the user's money to the forwarder.
            if amount % 10 != 0 || max_fee % 10 != 0 || max_fee > cfg.max_bridge_fee || max_fee * 2 > amount {
                panic_with_error!(&env, Error::BadAmount);
            }
            let recipient = mandate.evm_recipient.clone().unwrap_or_else(|| panic_with_error!(&env, Error::VenueNotAllowed));
            usdc.approve(&this, &cfg.messenger, &amount, &(env.ledger().sequence() + 100));
            TokenMessengerClient::new(&env, &cfg.messenger).deposit_for_burn_with_hook(
                &this,
                &amount,
                &cfg.dest_domain,
                &recipient,
                &cfg.usdc,
                &BytesN::from_array(&env, &[0; 32]),
                &max_fee,
                &CCTP_FINALITY_STANDARD,
                &Bytes::from_array(&env, &CCTP_FORWARD),
            );
            position.bridged += amount;
        }
        put(&env, &DataKey::Position(user.clone()), &position);
        #[allow(deprecated)]
        env.events().publish((symbol_short!("invest"), user), (venue, amount, max_fee));
    }

    /// Withdraws from the user's XOXNO position straight to the user. `amount` 0 withdraws everything.
    /// The user can always call it; the agent can too (for example to rebalance or follow a revoke).
    pub fn withdraw(env: Env, caller: Address, user: Address, amount: i128) -> i128 {
        caller.require_auth();
        let cfg = config(&env);
        if caller != user && caller != cfg.operator {
            panic_with_error!(&env, Error::NotAllowed);
        }
        if amount < 0 {
            panic_with_error!(&env, Error::BadAmount);
        }
        let mut position: Position = get(&env, &DataKey::Position(user.clone())).unwrap_or_default();
        if position.xoxno_account == 0 {
            panic_with_error!(&env, Error::NoPosition);
        }
        let key = HubAssetKey { asset: cfg.usdc.clone(), hub_id: cfg.hub_id };
        let paid = XoxnoClient::new(&env, &cfg.xoxno).withdraw(
            &env.current_contract_address(),
            &position.xoxno_account,
            &vec![&env, (key, amount)],
            &Some(user.clone()),
        );
        let total: i128 = paid.iter().map(|(_, a)| a).sum();
        if amount == 0 {
            // Emptied: XOXNO closes the account, so the next supply opens a new one.
            position.xoxno_account = 0;
            position.xoxno_principal = 0;
        } else {
            position.xoxno_principal = (position.xoxno_principal - total).max(0);
        }
        put(&env, &DataKey::Position(user.clone()), &position);
        #[allow(deprecated)]
        env.events().publish((symbol_short!("withdraw"), user), total);
        total
    }

    /// Keeps the user's XOXNO account alive; only the account owner (this contract) may renew it.
    pub fn renew(env: Env, user: Address) {
        let position: Position = get(&env, &DataKey::Position(user)).unwrap_or_default();
        if position.xoxno_account == 0 {
            panic_with_error!(&env, Error::NoPosition);
        }
        let cfg = config(&env);
        XoxnoClient::new(&env, &cfg.xoxno).renew_account(&env.current_contract_address(), &position.xoxno_account);
    }

    pub fn mandate(env: Env, user: Address) -> Option<Mandate> {
        env.storage().persistent().get(&DataKey::Mandate(user))
    }

    pub fn usage(env: Env, user: Address) -> Usage {
        env.storage().persistent().get(&DataKey::Usage(user)).unwrap_or_default()
    }

    pub fn position(env: Env, user: Address) -> Position {
        env.storage().persistent().get(&DataKey::Position(user)).unwrap_or_default()
    }

    /// The user's USDC in XOXNO now, interest included.
    pub fn xoxno_balance(env: Env, user: Address) -> i128 {
        let position: Position = env.storage().persistent().get(&DataKey::Position(user)).unwrap_or_default();
        if position.xoxno_account == 0 {
            return 0;
        }
        let cfg = config(&env);
        let key = HubAssetKey { asset: cfg.usdc, hub_id: cfg.hub_id };
        XoxnoClient::new(&env, &cfg.xoxno).get_collateral_amount(&position.xoxno_account, &key)
    }
}

fn config(env: &Env) -> Config {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey) -> Option<V> {
    let value = env.storage().persistent().get(key);
    if value.is_some() {
        env.storage().persistent().extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
    value
}

fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, value: &V) {
    env.storage().persistent().set(key, value);
    env.storage().persistent().extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}
