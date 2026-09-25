import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { parseDelimited, sniffDelimiter } from "../../src/core/importers/csv";
import { readXlsx, SpreadsheetError } from "../../src/core/importers/xlsx";
import { planSheet, planToDrafts, withHeaderRow } from "../../src/core/importers/mapping";
import { toCsv } from "../../src/core/exporters";
import { addItem, addItems, emptyVault } from "../../src/core/model";

const inflate = async (d: Uint8Array<ArrayBuffer>) => new Uint8Array(inflateRawSync(d));
const fixture = (n: string) => new Uint8Array(readFileSync(new URL("../fixtures/" + n, import.meta.url)));

describe("csv", () => {
  it("sniffs ; , tab and |", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(sniffDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(sniffDelimiter('name;note\n"x, y";"a, b, c"')).toBe(";");
  });
  it("parses Polish Excel CSV with BOM and semicolons (v1 read it as one column)", () => {
    const { rows, delimiter } = parseDelimited("﻿vendor;URL;username;password;notes\r\nNetflix;https://netflix.com;a@example.com;pw;\"multi\nline\"\r\n");
    expect(delimiter).toBe(";");
    expect(rows[0]).toEqual(["vendor", "URL", "username", "password", "notes"]);
    expect(rows[1][4]).toBe("multi\nline");
  });
  it("handles doubled quotes and blank lines", () => {
    expect(parseDelimited('a,b\n"he said ""hi""",x\n\n,\n').rows).toEqual([["a", "b"], ['he said "hi"', "x"]]);
  });
});

describe("xlsx reader", () => {
  it("reads every sheet of a real workbook", async () => {
    const sheets = await readXlsx(fixture("sample.xlsx"), inflate);
    expect(sheets.map(s => s.name)).toEqual(["Subskrypcje", "Konta bankowe", "Emergency Contacts", "Numbers"]);
    expect(sheets[0].rows[0]).toEqual(["vendor", "URL", "username", "password", "notes"]);
    expect(sheets[0].rows[1]).toEqual(["Amazon Prime", "https://www.amazon.co.uk/prime", "miekus@example.co.uk", "123", "£7.99"]);
    expect(sheets[1].rows[1]).toEqual(["HSBC", "12345678", "40-11-22", "kamil01", "S3cret!pass", "1234"]);
    expect(sheets[1].rows[2]).toEqual(["Revolut", "", "", "kamil@example.com", "Another#One"]);
    expect(sheets[1].rows[3]).toEqual(["", "gap row below"]);
    expect(sheets[2].rows[2][0]).toBe("Zażółć gęślą jaźń");
    expect(sheets[3].rows[1]).toEqual(["pi", "3.14159", "TRUE", "=1+1"]);
    expect(sheets[3].rows[2][1]).toBe("12345678901234");
  });
  it("handles prefixes, inline strings, rich text, stored entries, absolute targets", async () => {
    const [s] = await readXlsx(fixture("manual.xlsx"), inflate);
    expect(s.name).toBe("Loginy & hasła");
    expect(s.rows[0]).toEqual(["Nazwa ", "Hasło", "Uwagi"]);
    expect(s.rows[1]).toEqual(["Allegro", "p&ss<1>", "formula text"]);
    expect(s.rows[2]).toEqual(["", "", "only C5"]);
  });
  it("flags password-protected files", async () => {
    await expect(readXlsx(fixture("encrypted.xlsx"), inflate)).rejects.toMatchObject({ code: "encrypted" });
    await expect(readXlsx(new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>, inflate)).rejects.toBeInstanceOf(SpreadsheetError);
  });
});

describe("mapping", () => {
  it("maps English/Polish headers, keeps extra columns as custom fields", async () => {
    const sheets = await readXlsx(fixture("sample.xlsx"), inflate);
    const subs = planSheet(sheets[0].name, sheets[0].rows);
    expect(subs.mapping).toMatchObject({ title: 0, url: 1, username: 2, password: 3, notes: 4 });
    const d = planToDrafts(subs);
    expect(d).toHaveLength(3);
    expect(d[0]).toMatchObject({ title: "Amazon Prime", category: "Subskrypcje", password: "123", notes: "£7.99", type: "login" });

    const bank = planSheet(sheets[1].name, sheets[1].rows);
    expect(bank.mapping).toMatchObject({ title: 0, username: 3, password: 4 });
    const b = planToDrafts(bank);
    expect(b[0].fields!.map(f => [f.label, f.value, f.hidden])).toEqual([["Numer konta", "12345678", false], ["Sort code", "40-11-22", false], ["PIN", "1234", true]]);

    const contacts = planSheet(sheets[2].name, sheets[2].rows);
    expect(contacts.type).toBe("note");
    expect(planToDrafts(contacts)[1]).toMatchObject({ title: "Zażółć gęślą jaźń", type: "note" });
    expect(planToDrafts(contacts)[1].fields!.map(f => f.label)).toEqual(["Phone", "Relation"]);
  });
  it("detects Chrome, Bitwarden and 1Password exports", () => {
    const chrome = planSheet("Chrome Passwords.csv", parseDelimited("name,url,username,password,note\nsite,https://a.com,u,p,n").rows);
    expect(chrome.preset).toBe("Chrome");
    expect(planToDrafts(chrome)[0]).toMatchObject({ title: "site", url: "https://a.com", username: "u", password: "p", notes: "n", category: "Chrome Passwords" });
    const bw = planSheet("bw.csv", parseDelimited("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nWork,1,login,GitLab,,\"Recovery: abc\",0,https://gitlab.com,me,pw,JBSWY3DPEHPK3PXP").rows);
    expect(bw.preset).toBe("Bitwarden");
    expect(planToDrafts(bw)[0]).toMatchObject({ title: "GitLab", category: "Work", favorite: true, url: "https://gitlab.com", username: "me", password: "pw", totp: "JBSWY3DPEHPK3PXP", type: "login" });
    expect(planToDrafts(bw)[0].fields).toMatchObject([{ label: "Recovery", value: "abc" }]);
    const op = planSheet("1p.csv", parseDelimited("Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nX,https://x.com,u,p,otpauth://totp/X?secret=JBSWY3DPEHPK3PXP,false,false,,hi").rows);
    expect(op.preset).toBe("1Password");
    expect(planToDrafts(op)[0]).toMatchObject({ title: "X", totp: "otpauth://totp/X?secret=JBSWY3DPEHPK3PXP", notes: "hi", favorite: false });
  });
  it("finds a header row below a title row", () => {
    const rows = [["My passwords 2024"], ["Site", "Login", "Password"], ["A", "u", "p"]];
    const p = planSheet("s", rows);
    expect(p.headerRow).toBe(1);
    expect(planToDrafts(p)).toHaveLength(1);
    expect(planToDrafts(withHeaderRow(p, 0)).length).toBe(2);
  });
  it("round-trips through this app's CSV export", () => {
    let v = emptyVault();
    v = addItem(v, { type: "bank", title: "HSBC", category: "Banks", username: "u,1", password: 'p"q', notes: "a\nb", favorite: true, fields: [{ id: "1", label: "Sort code", value: "40-11-22", hidden: false }] }).vault;
    const csv = toCsv(v);
    const plan = planSheet("export.csv", parseDelimited(csv).rows);
    expect(plan.preset).toBe("Vault CSV");
    const [d] = planToDrafts(plan);
    expect(d).toMatchObject({ type: "bank", title: "HSBC", category: "Banks", username: "u,1", password: 'p"q', notes: "a\nb", favorite: true });
    expect(d.fields).toMatchObject([{ label: "Sort code", value: "40-11-22" }]);
    const again = addItems(emptyVault(), [d]);
    expect(again.items[0].title).toBe("HSBC");
  });
});
