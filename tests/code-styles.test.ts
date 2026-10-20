import { test, expect } from "bun:test";
import { styledTokens } from "../src/React/code-styles";
import { codeLanguage } from "../src/React/CodeContent";

test("C# uses distinct scopes for Unity types, method calls, strings and keywords", async () => {
  const source =
    'using UnityEngine;\npublic class Movecamera : MonoBehaviour {\n  Vector3 cameraVec;\n  void Start() { cameraVec = new Vector3(0.0f, 0.0f, 0.0f); GameObject.Find("Player"); }\n}';
  const lines = await styledTokens(source, codeLanguage("Movecamera.cs")!);
  expect(lines).not.toBeNull();
  expect(
    lines!.map((line) => line.map((t) => t.content).join("")).join("\n"),
  ).toBe(source);
  const tokens = lines!.flat();
  const color = (content: string) =>
    tokens.find((t) => t.content === content)?.color;
  expect(color("Vector3")).toBeTruthy();
  expect(color("Find")).toBeTruthy();
  expect(color("Vector3")).not.toBe(color("Find"));
  expect(color("public")).not.toBe(color("Vector3"));
  expect(await styledTokens(source, "C#")).toEqual(lines);
});

test("language selection preserves JSX and handles unknown languages safely", async () => {
  expect(codeLanguage("component.tsx")).toBe("tsx");
  expect(codeLanguage("component.jsx")).toBe("jsx");
  expect(
    await styledTokens("plain <script>text</script>", "unknown"),
  ).toBeNull();
  const python = await styledTokens(
    'def hello():\n    return "world"',
    "python",
  );
  expect(python!.flat().some((t) => t.content === "hello" && t.color)).toBe(
    true,
  );
});
