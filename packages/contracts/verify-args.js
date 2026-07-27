// Constructor args for LeburBatch as deployed on Sepolia (2026-07-27). Kept as a
// module because the ladder is an array, which the CLI cannot express.
export default [
  '0x838204BC3D82B29E3697Bfe9A17662c57943e34F', // token0 lUSDA
  '0x8A00F10b198f8cC9266d6E330b9792E395707CB7', // token1 lUSDB
  '0x9332437d2abdcca57143b96d6d1fce1ad51e7c35', // cToken0
  '0x37e9f9e43c929722cc61475db3eb053575e85efd', // cToken1
  '0x29f2087bc6489e9FC9f35CA34132Fca9158de7A0', // curve pool
  0, 1,                                          // pool coin indices
  ['999500000000000000', '1000000000000000000', '1000500000000000000', '1001000000000000000'],
  '1785172836',                                  // submit deadline
];
