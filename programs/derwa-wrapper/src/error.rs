use anchor_lang::prelude::*;

#[error_code]
pub enum DeRwaError {
    #[msg("wrap amount must be greater than zero")]
    ZeroAmount = 8000,

    #[msg("unwrap requires a valid attestation on the destination wallet")]
    AttestationRequired = 8001,

    #[msg("locked supply mismatch: cannot unwrap more than locked")]
    InsufficientLockedSupply = 8002,

    #[msg("permissioned mint does not match wrapper config")]
    MintMismatch = 8003,
}
