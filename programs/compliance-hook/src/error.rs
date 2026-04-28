use anchor_lang::prelude::*;

#[error_code]
pub enum ComplianceHookError {
    #[msg("Source or destination address is on the sanctions list")]
    SanctionedAddress = 6000,

    #[msg("Source or destination account is frozen")]
    AccountFrozen = 6001,

    #[msg("Destination wallet does not have a valid attestation")]
    AttestationNotFound = 6002,

    #[msg("Destination attestation is revoked")]
    AttestationRevoked = 6003,

    #[msg("Destination attestation has expired")]
    AttestationExpired = 6004,

    #[msg("Sanctions list update would exceed max capacity")]
    SanctionsListFull = 6005,

    #[msg("Update authority does not match SanctionsList authority")]
    UnauthorizedAuthority = 6006,

    #[msg("Pool policy requires higher investor class than attestation provides")]
    InvestorClassTooLow = 6007,

    #[msg("Pool policy does not permit this jurisdiction")]
    JurisdictionNotPermitted = 6008,
}
