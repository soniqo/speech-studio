import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../ipc/commands", () => ({
  clearActivityLog: vi.fn().mockResolvedValue(undefined),
  revealActivityLog: vi.fn().mockResolvedValue(undefined),
}));

import { ActivityPanel, ActivityToggle, formatGb } from "./ActivityPanel";
import { useActivityStore } from "../state/activityStore";
import { clearActivityLog, revealActivityLog } from "../ipc/commands";

beforeEach(() => {
  useActivityStore.setState({ open: true, lines: [], memory: null, logPath: null });
  vi.mocked(clearActivityLog).mockClear();
  vi.mocked(revealActivityLog).mockClear();
});

describe("ActivityPanel", () => {
  it("renders nothing while closed", () => {
    useActivityStore.setState({ open: false });
    const { container } = render(<ActivityPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists log lines with their source and shows the memory readout", () => {
    useActivityStore.setState({
      lines: [
        { seq: 1, tsMs: 0, source: "sidecar", text: "[sidecar] cosy ready" },
        { seq: 2, tsMs: 0, source: "studio", text: "[synth] clip c1 long-form: 3 chunks" },
      ],
      memory: {
        label: "post-load-cosyvoice",
        activeMb: 2150,
        cacheMb: 100,
        peakMb: 4400,
        rssMb: 2000,
        footprintMb: 5120,
        updatedAt: 0,
      },
    });
    render(<ActivityPanel />);
    expect(screen.getByText("[sidecar] cosy ready")).toBeInTheDocument();
    expect(screen.getByText("[synth] clip c1 long-form: 3 chunks")).toBeInTheDocument();
    expect(screen.getByText("sidecar")).toBeInTheDocument();
    expect(screen.getByText("MLX 2.1 GB · peak 4.3 GB · process 5.0 GB")).toBeInTheDocument();
  });

  it("says so while no memory snapshot has arrived", () => {
    render(<ActivityPanel />);
    expect(screen.getByText("memory: waiting for the engine")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log file" })).toBeDisabled();
  });

  it("copies the visible log and reveals the log file", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useActivityStore.setState({
      lines: [{ seq: 1, tsMs: 0, source: "studio", text: "hello" }],
      logPath: "/tmp/speech-studio.log",
    });
    render(<ActivityPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("studio  hello");
    fireEvent.click(screen.getByRole("button", { name: "Log file" }));
    await waitFor(() => expect(revealActivityLog).toHaveBeenCalledTimes(1));
  });

  it("clears both the panel and the shell's ring", async () => {
    useActivityStore.setState({ lines: [{ seq: 1, tsMs: 0, source: "studio", text: "hello" }] });
    render(<ActivityPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(useActivityStore.getState().lines).toEqual([]);
    await waitFor(() => expect(clearActivityLog).toHaveBeenCalledTimes(1));
  });
});

describe("ActivityToggle", () => {
  it("shows the process footprint and opens the panel", () => {
    useActivityStore.setState({ open: false, memory: { label: "x", footprintMb: 4300, updatedAt: 0 } });
    render(<ActivityToggle />);
    const button = screen.getByRole("button", { name: /Activity/ });
    expect(button).toHaveTextContent("4.2 GB");
    fireEvent.click(button);
    expect(useActivityStore.getState().open).toBe(true);
  });
});

describe("formatGb", () => {
  it("renders MiB as GiB with one decimal", () => {
    expect(formatGb(1024)).toBe("1.0");
    expect(formatGb(5120)).toBe("5.0");
    expect(formatGb(2150)).toBe("2.1");
  });
});
