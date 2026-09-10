const WALLET_NAMES = {
  NG: "Nagad",
  NAGAD: "Nagad",
  BK: "Bkash",
  BKASH: "Bkash",
  RK: "Rocket",
  ROCKET: "Rocket",
  UPAY: "Upay"
};

export const normalizeWalletName = (value) => WALLET_NAMES[String(value || "").trim().toUpperCase()] || null;
