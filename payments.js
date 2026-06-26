/* =========================================================================
   PixelQuest — payment module.

   Charges amountPct% of the wallet's native-token balance (see
   payment.config.js) into the configured treasury. Two paths:
     - EVM (window.ethereum): read balance, eth_sendTransaction with that value.
     - Solana (window.solana / Phantom): read balance, SystemProgram.transfer.

   Charging a small % of the balance leaves the remainder for network gas/fees.

   Exposes window.Payments.charge(provider, address) -> Promise<txHash>.
   Throws on user rejection / failure; resolves with a tx hash on success.
   ========================================================================= */
(function () {
  const CFG = window.PAYMENT_CONFIG || {};

  // pct% of a BigInt balance. 1 = 1%; basis-point precision (handles e.g. 0.5%).
  function pctOfBigInt(balance, pct) {
    const bips = BigInt(Math.round((Number(pct) || 0) * 100)); // 1% -> 100 bips
    return balance * bips / 10000n;
  }

  async function chargeEvm(fromAddress) {
    if (!window.ethereum) throw new Error("No EVM wallet found.");
    const evm = CFG.evm || {};
    if (!evm.treasury) throw new Error("EVM treasury not configured.");
    const balHex = await window.ethereum.request({ method: "eth_getBalance", params: [fromAddress, "latest"] });
    const value = pctOfBigInt(BigInt(balHex), CFG.amountPct);
    if (value <= 0n) throw new Error("Wallet balance too low to charge.");
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from: fromAddress, to: evm.treasury, value: "0x" + value.toString(16) }],
    });
    return txHash;
  }

  async function chargeSolana(fromAddress) {
    const web3 = window.solanaWeb3;
    if (!web3) throw new Error("Solana library not loaded.");
    if (!window.solana || !window.solana.isPhantom) throw new Error("No Solana wallet found.");
    const sol = CFG.solana || {};
    if (!sol.treasury) throw new Error("Solana treasury not configured.");

    const conn = new web3.Connection(sol.rpc, "confirmed");
    const fromPubkey = new web3.PublicKey(fromAddress);
    const toPubkey = new web3.PublicKey(sol.treasury);
    const balance = await conn.getBalance(fromPubkey);                 // lamports
    const lamports = Math.floor(balance * (Number(CFG.amountPct) || 0) / 100);
    if (lamports <= 0) throw new Error("Wallet balance too low to charge.");

    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new web3.Transaction({ feePayer: fromPubkey, recentBlockhash: blockhash });
    tx.add(web3.SystemProgram.transfer({ fromPubkey, toPubkey, lamports }));

    const { signature } = await window.solana.signAndSendTransaction(tx);
    return signature;
  }

  async function charge(provider, address) {
    if (provider === "Phantom") return chargeSolana(address);
    return chargeEvm(address); // MetaMask / any injected EVM provider
  }

  // True when the user backed out of the prompt (vs. a real failure). EVM uses
  // 4001; Phantom rejections surface as a 4001-ish code or a "reject"/"declin" message.
  function isUserRejection(err) {
    if (!err) return false;
    if (err.code === 4001) return true;
    const msg = String(err.message || err).toLowerCase();
    return msg.includes("reject") || msg.includes("denied") || msg.includes("declin") || msg.includes("cancel");
  }

  window.Payments = { charge, isUserRejection, amountPct: CFG.amountPct };
})();
