use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use anchor_lang::Accounts;
use crate::state::SwapState;
use raydium_amm_v3::amm_v3::cpi::accounts::SwapSingle;
use raydium_amm_v3::amm_v3::cpi::swap;

#[derive(AnchorSerialize, AnchorDeserialize)]
struct RaydiumSwapData {
    amount: u64,
    other_amount_threshold: u64,
    sqrt_price_limit_x64: u128,
    is_base_input: bool,
}

pub fn _raydium_swap<'info>(
    ctx: &Context<'_, '_, '_, 'info, RaydiumSwap<'info>>, 
    amount_in: u64,
    a_to_b: bool,
) -> Result<()> {
    
    let cpi_program = ctx.accounts.raydium_swap_program.to_account_info();
    let cpi_accounts = SwapSingle {
        payer: ctx.accounts.payer.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account: ctx.accounts.user_src.to_account_info(),
        output_token_account: ctx.accounts.user_dst.to_account_info(),
        input_vault: ctx.accounts.input_vault.to_account_info(),
        output_vault: ctx.accounts.output_vault.to_account_info(),
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        tick_array: ctx.accounts.tick_array.to_account_info(),
    };
    let mut cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    for tick_array_info in ctx.remaining_accounts {
        cpi_ctx.remaining_accounts.push(tick_array_info.clone());
    }
    swap(cpi_ctx, amount_in, 0u64, 0u128, a_to_b)
}

#[derive(Accounts, Clone)]
pub struct RaydiumSwap<'info> {
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: 3rd part struct
    pub amm_config: AccountInfo<'info>,
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub pool_state : AccountInfo<'info>,
    #[account(mut)]
    pub user_src: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_dst: Account<'info, TokenAccount>,
    #[account(mut)]
    pub input_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub output_vault: Account<'info, TokenAccount>,
    /// CHECK: 3 3rd part struct
    #[account(mut)]
    pub observation_state: AccountInfo<'info>,
    /// CHECK: 3rd part struct
    pub token_program: AccountInfo<'info>,
    /// CHECK: 3 3rd part struct
    #[account(mut)]
    pub tick_array: AccountInfo<'info>,
    /// CHECK: 3rd part struct
    pub raydium_swap_program: AccountInfo<'info>,
    #[account(mut, seeds=[b"swap_state"], bump)] 
    pub swap_state: Account<'info, SwapState>,
}
