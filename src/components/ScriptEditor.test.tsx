import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScriptEditor } from "./ScriptEditor";
import { EMOTION_TAGS } from "../types/project";

describe("ScriptEditor", () => {
  it("prefixes the line with a parenthetical emotion tag when one is clicked", () => {
    const onChange = vi.fn();
    render(<ScriptEditor value="Hello world" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "excited" }));
    expect(onChange).toHaveBeenCalledWith("(excited) Hello world");
  });

  it("replaces an existing parenthetical tag instead of stacking", () => {
    const onChange = vi.fn();
    render(<ScriptEditor value="(whispering) Just stay quiet." onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "excited" }));
    expect(onChange).toHaveBeenCalledWith("(excited) Just stay quiet.");
  });

  it("removes the existing tag when its own button is clicked again", () => {
    const onChange = vi.fn();
    render(<ScriptEditor value="(whispering) Just stay quiet." onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "whispering" }));
    expect(onChange).toHaveBeenCalledWith("Just stay quiet.");
  });

  it("replaces legacy XML-style tags too", () => {
    const onChange = vi.fn();
    render(<ScriptEditor value="<whisper>Hush now.</whisper>" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "soft" }));
    expect(onChange).toHaveBeenCalledWith("(soft) Hush now.");
  });

  it("renders one button per emotion tag", () => {
    render(<ScriptEditor value="" onChange={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(EMOTION_TAGS.length);
  });
});
