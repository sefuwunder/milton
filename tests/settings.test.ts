// settings.test.ts — F1 settings KV: get/set/del, JSON helpers, guards.
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initSettingsDb,
  getSetting,
  setSetting,
  delSetting,
  getSettingJSON,
  setSettingJSON,
  allSettings,
} from "/home/hatch/workspace/your_files/milton/src/settings";

// NOTE: must be top-level — a beforeAll nested inside another hook fires at
// the wrong time in bun test.
beforeAll(() => { initSettingsDb(new Database(":memory:")); });

describe("settings KV", () => {
  test("missing key returns null", () => {
    expect(getSetting("nope.never.set")).toBeNull();
  });

  test("set then get round-trips the string", () => {
    setSetting("t.k1", "hello");
    expect(getSetting("t.k1")).toBe("hello");
  });

  test("set overwrites an existing key", () => {
    setSetting("t.k2", "one");
    setSetting("t.k2", "two");
    expect(getSetting("t.k2")).toBe("two");
  });

  test("values are coerced to strings", () => {
    setSetting("t.k3", 42 as any);
    expect(getSetting("t.k3")).toBe("42");
  });

  test("del removes the key and reports true; missing key reports false", () => {
    setSetting("t.k4", "x");
    expect(delSetting("t.k4")).toBe(true);
    expect(getSetting("t.k4")).toBeNull();
    expect(delSetting("t.k4")).toBe(false);
  });

  test("empty key is rejected", () => {
    expect(() => setSetting("", "v")).toThrow();
  });

  test("JSON helpers round-trip objects", () => {
    setSettingJSON("t.j1", { a: 1, b: ["x"] });
    expect(getSettingJSON("t.j1", null)).toEqual({ a: 1, b: ["x"] });
  });

  test("getSettingJSON falls back on missing or corrupt values", () => {
    expect(getSettingJSON("t.j.missing", { d: 1 })).toEqual({ d: 1 });
    setSetting("t.j.bad", "{not json");
    expect(getSettingJSON("t.j.bad", "fb")).toBe("fb");
  });

  test("allSettings returns sorted keys", () => {
    setSetting("t.z", "1");
    setSetting("t.a", "2");
    const all = allSettings();
    expect(all["t.z"]).toBe("1");
    expect(all["t.a"]).toBe("2");
    expect(Object.keys(all).sort()).toEqual(Object.keys(all));
  });
});
