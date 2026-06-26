/* =========================================================================
   PixelQuest — payment module.

   Charges N native tokens (see payment.config.js) from the connected wallet
   into the configured treasury. Two paths:
     - EVM (window.ethereum): eth_sendTransaction with a native-token value.
     - Solana (window.solana / Phantom): SystemProgram.transfer via web3.js.

   Exposes window.Payments.charge(provider, address) -> Promise<txHash>.
   Throws on user rejection / failure; resolves with a tx hash on success.
   ========================================================================= */
(function () {
  const CFG = window.PAYMENT_CONFIG || {};

  // 0.1 -> "0x16345785d8a0000" (wei). String math via BigInt avoids float drift.
  function nativeToWeiHex(amount) {
    return "0x" + tokensToBaseUnits(amount, 18).toString(16);
  }

  // amount (decimal) * 10^decimals, exact, using BigInt on the string form.
  function tokensToBaseUnits(amount, decimals) {
    const [whole, frac = ""] = String(amount).split(".");
    const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  }

  async function chargeEvm(fromAddress) {
    if (!window.ethereum) throw new Error("No EVM wallet found.");
    const evm = CFG.evm || {};
    if (!evm.treasury) throw new Error("EVM treasury not configured.");
    const valueHex = nativeToWeiHex(CFG.amount);
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from: fromAddress, to: evm.treasury, value: valueHex }],
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
    const lamports = Number(tokensToBaseUnits(CFG.amount, 9)); // LAMPORTS_PER_SOL = 1e9

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

  window.Payments = { charge, isUserRejection, amount: CFG.amount };
})();
