// Clients for the contracts Nilo invests through. Only the functions Nilo calls
// are declared; the types must match the deployed contracts' specs.
use soroban_sdk::{contractclient, contracttype, Address, Bytes, BytesN, Env, Vec};

/// XOXNO Lending's key for an asset in a liquidity hub.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HubAssetKey {
    pub asset: Address,
    pub hub_id: u32,
}

#[allow(dead_code)]
#[contractclient(name = "XoxnoClient")]
pub trait Xoxno {
    fn supply(env: Env, caller: Address, account_id: u64, spoke_id: u32, assets: Vec<(HubAssetKey, i128)>) -> u64;
    fn withdraw(
        env: Env,
        caller: Address,
        account_id: u64,
        withdrawals: Vec<(HubAssetKey, i128)>,
        to: Option<Address>,
    ) -> Vec<(HubAssetKey, i128)>;
    fn renew_account(env: Env, caller: Address, account_id: u64);
    fn account_exists(env: Env, account_id: u64) -> bool;
    fn get_collateral_amount(env: Env, account_id: u64, hub_asset: HubAssetKey) -> i128;
    fn get_pool_address(env: Env) -> Address;
}

#[allow(dead_code)]
#[contractclient(name = "TokenMessengerClient")]
pub trait TokenMessenger {
    #[allow(clippy::too_many_arguments)]
    fn deposit_for_burn_with_hook(
        env: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
        hook_data: Bytes,
    );
}
