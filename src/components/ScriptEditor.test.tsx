import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScriptEditor } from "./ScriptEditor";
import { EMOTION_TAGS } from "../types/project";
import { useProjectStore } from "../state/projectStore";

describe("ScriptEditor", () => {
  beforeEach(() => {
    useProjectStore.setState({
      model: {
        engine: "voxcpm2",
        language: "en",
        engines: [],
        status: "idle",
      },
    });
  });

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

  it("uses Indic-Mio suffix tags when the active engine asks for suffix markers", () => {
    useProjectStore.setState({
      model: {
        engine: "indic-mio",
        language: "hi",
        engines: [
          {
            id: "indic-mio",
            displayName: "Indic-Mio",
            requiresReferenceTranscript: false,
            requiresLanguage: false,
            styleMode: "suffix-tag",
          },
        ],
        status: "ready",
      },
    });
    const onChange = vi.fn();
    render(<ScriptEditor value="नमस्ते" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "angry" }));
    expect(onChange).toHaveBeenCalledWith("नमस्ते <angry>");
  });

  it("uses Fish Audio bracket tags when the active engine asks for bracket markers", () => {
    useProjectStore.setState({
      model: {
        engine: "fish-audio",
        language: "en",
        engines: [
          {
            id: "fish-audio",
            displayName: "Fish Audio S2 Pro",
            requiresReferenceTranscript: true,
            requiresLanguage: false,
            styleMode: "bracket-tag",
          },
        ],
        status: "ready",
      },
    });
    const onChange = vi.fn();
    render(<ScriptEditor value="नमस्ते [sad]" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "excited" }));
    expect(onChange).toHaveBeenCalledWith("नमस्ते [excited]");
  });
});
