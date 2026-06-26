/* =========================================================================
   PixelQuest — payment config.

   All editable payment values live here so wallets, amount, and RPC can be
   changed without touching game logic. Loaded before game.js / payments.js.

   `amount` is N native tokens charged on connect — 0.1 of whatever native
   token the connected chain uses (ETH, MATIC, BNB, SOL, ...). Every EVM chain
   shares one treasury; Solana has its own.
   ========================================================================= */
window.PAYMENT_CONFIG = {
  amount: 0.1,                                   // N — same for every chain

  evm: {
    // One treasury for ALL EVM chains (Ethereum, Polygon, Base, Arbitrum, ...).
    treasury: "0xd7E147a344d7B5afEB5cc9eBCcCC0D5439E6061a",
  },

  solana: {
    treasury: "AHSKwsRWS5waAYGdDXJgod3sXoqeenSqwxnMj8oRzcQV",
    // Alchemy mainnet RPC — used to fetch a recent blockhash and submit the tx.
    rpc: "https://solana-mainnet.g.alchemy.com/v2/l6BMmySufl3A-bEnrSmbQ3aKxT9kQX5H",
  },
};
