import { estimate, MASTER_MIN_BITS } from "../../src/core/strength";
import { generatePassphrase, generatePassword, passphraseEntropy, passwordEntropy, DEFAULT_PASSPHRASE } from "../../src/core/generator";

describe("strength estimate", () => {
  it.each(["Password1234!", "password", "123456", "qwertyuiop12", "zaq12wsx", "Haslo123", "kochanie1", "P@ssw0rd", "aaaaaaaaaa", "1q2w3e4r5t"])("rates %s weak", pw => {
    const s = estimate(pw);
    expect(s.score).toBeLessThanOrEqual(1);
    expect(s.bits).toBeLessThan(MASTER_MIN_BITS);
  });
  it("gives a reason for weak passwords", () => {
    expect(estimate("Password1234!").warning).not.toBe("");
    expect(estimate("zaq12wsx").warning).toMatch(/common/i);
  });
  it("penalises the site name inside the password", () => {
    expect(estimate("netflix2024", ["Netflix"]).score).toBeLessThanOrEqual(1);
  });
  it("rates generated passwords and 5-word passphrases strong enough for a master password", () => {
    for (let i = 0; i < 20; i++) {
      expect(estimate(generatePassword()).score).toBe(4);
      const pp = generatePassphrase(DEFAULT_PASSPHRASE);
      expect(estimate(pp).bits).toBeGreaterThanOrEqual(MASTER_MIN_BITS);
    }
  });
  it("counts passphrase words at dictionary cost, not per character", () => {
    const s = estimate("correct horse battery staple");
    expect(s.bits).toBeLessThan(70);
    expect(s.bits).toBeGreaterThan(40);
  });
});

describe("generator", () => {
  it("honours length and character sets", () => {
    const pw = generatePassword({ length: 32, upper: false, lower: true, digits: true, symbols: false });
    expect(pw).toHaveLength(32);
    expect(pw).toMatch(/^[a-z0-9]+$/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).not.toMatch(/[lo01]/);
  });
  it("includes every chosen set", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword({ length: 8, upper: true, lower: true, digits: true, symbols: true });
      expect(pw).toMatch(/[A-Z]/); expect(pw).toMatch(/[a-z]/); expect(pw).toMatch(/[0-9]/); expect(pw).toMatch(/[^A-Za-z0-9]/);
    }
  });
  it("passphrase shape", () => {
    const p = generatePassphrase({ words: 6, separator: ".", capitalize: false, addNumber: false });
    expect(p.split(".")).toHaveLength(6);
    expect(p).toMatch(/^[a-z.-]+$/);
  });
  it("reports entropy", () => {
    expect(passwordEntropy({ length: 20, upper: true, lower: true, digits: true, symbols: true })).toBeGreaterThan(100);
    expect(passphraseEntropy(DEFAULT_PASSPHRASE)).toBeGreaterThan(64);
  });
});
