import { 
  parseConfigValue, 
  formatHelpText 
} from "./formatters.js";

describe("CLI Formatters", () => {
  describe("parseConfigValue", () => {
    it("should parse booleans", () => {
      expect(parseConfigValue("true")).toBe(true);
      expect(parseConfigValue("false")).toBe(false);
      expect(parseConfigValue("TRUE")).toBe(true);
      expect(parseConfigValue("FALSE")).toBe(false);
    });

    it("should parse null", () => {
      expect(parseConfigValue("null")).toBeNull();
      expect(parseConfigValue("NULL")).toBeNull();
    });

    it("should parse numbers", () => {
      expect(parseConfigValue("123")).toBe(123);
      expect(parseConfigValue("12.34")).toBe(12.34);
      expect(parseConfigValue("-42")).toBe(-42);
    });

    it("should parse JSON arrays and objects", () => {
      expect(parseConfigValue("[1, 2, 3]")).toEqual([1, 2, 3]);
      expect(parseConfigValue('{"key": "value"}')).toEqual({ key: "value" });
    });

    it("should fallback to string", () => {
      expect(parseConfigValue("hello")).toBe("hello");
      expect(parseConfigValue("123a")).toBe("123a");
    });
    
    it("should return empty string for empty input", () => {
      expect(parseConfigValue("")).toBe("");
      expect(parseConfigValue(undefined)).toBe("");
      expect(parseConfigValue(null)).toBe("");
    });
  });

  describe("formatHelpText", () => {
    it("should return a string containing help commands", () => {
      const text = formatHelpText();
      expect(text).toContain("/help");
      expect(text).toContain("/status");
      expect(text).toContain("/wallet");
      expect(text).toContain("/positions");
      expect(text).toContain("/deploy");
      expect(text).toContain("/pause");
      expect(text).toContain("/resume");
    });
  });
});
