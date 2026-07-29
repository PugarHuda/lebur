// Constructor args for LeburBatch. Kept as a module because the ladder is an
// array, which the verify CLI cannot express positionally.
//
// Parameterised by env, and specifically because of `submitDeadline`: it is a
// constructor argument that `startNewBatch` later OVERWRITES. Reading the live
// contract to reconstruct its own constructor argument therefore gives the wrong
// number on any deployment that has been reset, and verification fails with a
// bytecode mismatch that looks like a compiler-settings problem and is not.
//
//   VERIFY_CTOKEN0=… VERIFY_CTOKEN1=… VERIFY_DEADLINE=… \
//     npx hardhat verify blockscout --network sepolia <address>
export default [
  process.env.VERIFY_TOKEN0 ?? '0x838204BC3D82B29E3697Bfe9A17662c57943e34F', // token0 lUSDA
  process.env.VERIFY_TOKEN1 ?? '0x8A00F10b198f8cC9266d6E330b9792E395707CB7', // token1 lUSDB
  process.env.VERIFY_CTOKEN0 ?? '0xd9953a0fcb3ad1077bfd8978a6bdef3a3f05638b', // cToken0
  process.env.VERIFY_CTOKEN1 ?? '0x649bca4a169a0a9bcc386e2a5e4f15aa3b238a1a', // cToken1
  process.env.VERIFY_POOL ?? '0x29f2087bc6489e9FC9f35CA34132Fca9158de7A0',    // curve pool
  0, 1,                                          // pool coin indices
  ['999500000000000000', '1000000000000000000', '1000500000000000000', '1001000000000000000'],
  process.env.VERIFY_DEADLINE ?? '1785296016',   // submit deadline AT CONSTRUCTION
];
