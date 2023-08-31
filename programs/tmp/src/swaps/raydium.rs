use anchor_lang::prelude::*;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program;
use anchor_spl::token::TokenAccount;
use anchor_lang::Accounts;
use crate::state::SwapState;

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

    let data = RaydiumSwapData {
        amount: amount_in,
        other_amount_threshold: 0u64, // no saftey lmfao 
        sqrt_price_limit_x64: 0u128,
        is_base_input: a_to_b,
    };
    
    let mut ix_accounts = vec![
        AccountMeta::new(*ctx.accounts.payer.key, true),

        AccountMeta::new_readonly(*ctx.accounts.amm_config.key, false),
        AccountMeta::new(*ctx.accounts.pool_state.key, true),
        
        AccountMeta::new(ctx.accounts.user_src.key(), false),
        AccountMeta::new(ctx.accounts.user_dst.key(), false),
        AccountMeta::new(ctx.accounts.input_vault.key(), false),
        AccountMeta::new(ctx.accounts.output_vault.key(), false),
        AccountMeta::new(*ctx.accounts.observation_state.key, false),
        AccountMeta::new(*ctx.accounts.token_program.key, false),

        AccountMeta::new(*ctx.accounts.tick_array.key, false),
    ];

    for tick_array_info in ctx.remaining_accounts {
        ix_accounts.push(AccountMeta::new(*tick_array_info.key, false));
    }

    let instruction = Instruction {
        program_id: *ctx.accounts.raydium_swap_program.key,
        accounts: ix_accounts,
        data: data.try_to_vec()?,
    };

    let accounts = vec![
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.amm_config.to_account_info(),
        ctx.accounts.pool_state.to_account_info(),
        ctx.accounts.user_src.to_account_info(),
        ctx.accounts.user_dst.to_account_info(),
        ctx.accounts.input_vault.to_account_info(),
        ctx.accounts.output_vault.to_account_info(),
        ctx.accounts.observation_state.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.tick_array.to_account_info()
    ];

    solana_program::program::invoke(
        &instruction, 
        &accounts, 
    )?;

    Ok(())
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
