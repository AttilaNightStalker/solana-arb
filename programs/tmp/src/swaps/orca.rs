use anchor_lang::prelude::*;
use solana_program;
use anchor_spl::token::TokenAccount;

use anchor_lang::Accounts;
use crate::state::SwapState;
use whirlpool::whirlpool::cpi::{accounts::Swap, swap};

#[derive(AnchorSerialize, AnchorDeserialize)]
struct OrcaSwapData {
    amount: u64,
    other_amount_threshold: u64,
    sqrt_price_limit: u128,
    amount_specified_is_input: bool,
    a_to_b: bool,
}

pub fn _orca_swap<'info>(
    ctx: &Context<'_, '_, '_, 'info, OrcaSwap<'info>>, 
    amount_in: u64,
    a_to_b: bool,
) -> Result<()> {
    
    let cpi_program = ctx.accounts.whirlpool.to_account_info();
    let cpi_accounts = Swap {
        token_program: ctx.accounts.token_program.to_account_info(),
        token_authority: ctx.accounts.token_authority.to_account_info(),
        whirlpool: ctx.accounts.whirlpool.to_account_info(),
        token_owner_account_a: ctx.accounts.token_owner_account_a.to_account_info(),
        token_vault_a: ctx.accounts.token_vault_a.to_account_info(),
        token_owner_account_b: ctx.accounts.token_owner_account_b.to_account_info(),
        token_vault_b: ctx.accounts.token_vault_b.to_account_info(),
        tick_array_0: ctx.accounts.tick_array_0.to_account_info(),
        tick_array_1: ctx.accounts.tick_array_1.to_account_info(),
        tick_array_2: ctx.accounts.tick_array_2.to_account_info(),
        oracle: ctx.accounts.oracle.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    swap(cpi_ctx, amount_in, 0u64, if a_to_b { 4295048016u128 } else { 79226673515401279992447579055u128 }, true, a_to_b)
}

#[derive(Accounts)]
pub struct OrcaSwap<'info> {
    /// CHECK: 3rd part struct
    pub token_program: AccountInfo<'info>,
    pub token_authority: Signer<'info>,
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub whirlpool: AccountInfo<'info>,
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub token_owner_account_a: Account<'info, TokenAccount>,
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub token_vault_a: Account<'info, TokenAccount>,
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub token_owner_account_b: Account<'info, TokenAccount>,
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub token_vault_b: Account<'info, TokenAccount>,
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub tick_array_0: AccountInfo<'info>,
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub tick_array_1: AccountInfo<'info>,
    /// CHECK: 3rd part struct
    #[account(mut)]
    pub tick_array_2: AccountInfo<'info>,
    /// CHECK: Oracle is currently unused and will be enabled on subsequent updates
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: 3rd part struct
    pub orca_swap_program: AccountInfo<'info>,
    #[account(mut, seeds=[b"swap_state"], bump)] 
    pub swap_state: Account<'info, SwapState>,
}

