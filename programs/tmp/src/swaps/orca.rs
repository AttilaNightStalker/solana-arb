use anchor_lang::prelude::*;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program;
use anchor_spl::token::TokenAccount;

use anchor_lang::Accounts;
use crate::state::SwapState;

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
    
    let data = OrcaSwapData {
        amount: amount_in,
        other_amount_threshold: 0u64, // no saftey lmfao 
        sqrt_price_limit: if a_to_b { 4295048016u128 } else { 79226673515401279992447579055u128 },
        amount_specified_is_input: true,
        a_to_b,
    };

    let ix_accounts = vec![
        AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
        AccountMeta::new_readonly(*ctx.accounts.token_authority.key, true),

        AccountMeta::new(*ctx.accounts.whirlpool.key, false),
        AccountMeta::new(ctx.accounts.token_owner_account_a.key(), false),
        AccountMeta::new(ctx.accounts.token_vault_a.key(), false),
        AccountMeta::new(ctx.accounts.token_owner_account_b.key(), false),
        AccountMeta::new(ctx.accounts.token_vault_b.key(), false),
        AccountMeta::new(ctx.accounts.tick_array_0.key(), false),
        AccountMeta::new(ctx.accounts.tick_array_1.key(), false),
        AccountMeta::new(ctx.accounts.tick_array_2.key(), false),
      
        AccountMeta::new_readonly(*ctx.accounts.oracle.key, false),
    ];

    let instruction = Instruction {
        program_id: *ctx.accounts.token_program.key,
        accounts: ix_accounts,
        data: data.try_to_vec()?,
    };

    let accounts = vec![
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.token_authority.to_account_info(),
        ctx.accounts.whirlpool.to_account_info(),
        ctx.accounts.token_owner_account_a.to_account_info(),
        ctx.accounts.token_vault_a.to_account_info(),
        ctx.accounts.token_owner_account_b.to_account_info(),
        ctx.accounts.token_vault_b.to_account_info(),
        ctx.accounts.tick_array_0.to_account_info(),
        ctx.accounts.tick_array_1.to_account_info(),
        ctx.accounts.tick_array_2.to_account_info(),
        ctx.accounts.oracle.to_account_info(),
    ];

    solana_program::program::invoke(
        &instruction, 
        &accounts, 
    )?;
    
    Ok(())
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

