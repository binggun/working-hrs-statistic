import argon2 from "argon2";

export const SHOP_LOGIN_PASSWORD = "123456";

export async function passwordMatches(account, password) {
  if (account.role === "SHOP") return password === SHOP_LOGIN_PASSWORD;
  return !!account.password_hash && await argon2.verify(account.password_hash, password);
}
