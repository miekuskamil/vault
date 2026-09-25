import { base32Decode, hotp, parseTotp, totpAt, formatCode } from "../../src/core/totp";

const ascii = (s: string) => new Uint8Array(new TextEncoder().encode(s));

describe("TOTP (RFC 6238 / RFC 4226 test vectors)", () => {
  it("HOTP RFC 4226 appendix D", async () => {
    const secret = ascii("12345678901234567890");
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    for (let i = 0; i < 10; i++) expect(await hotp(secret, i)).toBe(expected[i]);
  });
  it.each([
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1234567890, "89005924", "91819424", "93441116"],
    [20000000000, "65353130", "77737706", "47863826"],
  ])("TOTP at %i", async (t, sha1, sha256, sha512) => {
    const s1 = ascii("12345678901234567890");
    const s256 = ascii("12345678901234567890123456789012");
    const s512 = ascii("1234567890123456789012345678901234567890123456789012345678901234");
    expect((await totpAt({ secret: s1, digits: 8, period: 30, algorithm: "SHA-1" }, t * 1000)).code).toBe(sha1);
    expect((await totpAt({ secret: s256, digits: 8, period: 30, algorithm: "SHA-256" }, t * 1000)).code).toBe(sha256);
    expect((await totpAt({ secret: s512, digits: 8, period: 30, algorithm: "SHA-512" }, t * 1000)).code).toBe(sha512);
  });
  it("parses otpauth URIs and bare secrets", () => {
    const c = parseTotp("otpauth://totp/GitHub:kamil?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30")!;
    expect(c.issuer).toBe("GitHub");
    expect(c.account).toBe("kamil");
    expect(c.digits).toBe(6);
    expect(parseTotp("jbsw y3dp ehpk 3pxp")!.secret).toEqual(base32Decode("JBSWY3DPEHPK3PXP"));
    expect(parseTotp("not a secret!")).toBeNull();
    expect(parseTotp("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP")).toBeNull();
  });
  it("remaining seconds and formatting", async () => {
    const r = await totpAt(parseTotp("JBSWY3DPEHPK3PXP")!, 1_000_000_010_000);
    expect(r.remaining).toBe(10);
    expect(formatCode("123456")).toBe("123 456");
  });
});
