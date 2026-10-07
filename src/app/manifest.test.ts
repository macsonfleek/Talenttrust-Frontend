import { readFileSync } from "fs";
import { join } from "path";

describe("src/app/manifest.ts", () => {
  const manifestPath = join(process.cwd(), "src", "app", "manifest.ts");
  const source = readFileSync(manifestPath, "utf-8");

  it("exists and exports a default manifest object", () => {
    expect(source).toMatch(/export default/);
  });

  it("declares a name and short_name within bounds", () => {
    const nameMatch = source.match(/name:\s*['"]([^'"]+)['"]/);
    const shortNameMatch = source.match(/short_name:\s*['"]([^'"]+)['"]/);
    expect(nameMatch).toBeTruthy();
    expect(shortNameMatch).toBeTruthy();
    expect(nameMatch![1].length).toBeLessThanOrEqual(45);
    expect(shortNameMatch![1].length).toBeLessThanOrEqual(12);
  });

  it("declares a start_url that is an absolute path or absolute URL", () => {
    const match = source.match(/start_url:\s*['"]([^'"]+)['"]/);
    expect(match).toBeTruthy();
    const value = match![1];
    expect(value.startsWith("/") || /^https?:\/\//.test(value)).toBe(true);
  });

  it("declares a display mode from the allowed set", () => {
    const match = source.match(/display:\s*['"]([^'"]+)['"]/);
    expect(match).toBeTruthy();
    expect([
      "fullscreen",
      "standalone",
      "minimal-ui",
      "browser",
    ]).toContain(match![1]);
  });

  it("declares an icons array with at least one entry", () => {
    expect(source).toMatch(/icons:\s*\[/);
    expect(source).toMatch(/src:/);
  });

  it("declares a theme_color as a hex color", () => {
    const match = source.match(/theme_color:\s*['"]([^'"]+)['"]/);
    expect(match).toBeTruthy();
    expect(match![1]).toMatch(/^#[0-9A-Fa-f]{6}$|^#[0-9A-Fa-f]{3}$/);
  });

  it("does not contain placeholder or unresolved template literals", () => {
    expect(source).not.toMatch(/example\.com/i);
    expect(source).not.toMatch(/TODO|FIXME/);
  });
});
