export type SetupStep = {
  id: string;
  number: string;
  title: string;
  summary: string;
  status: "verified" | "placeholder";
  detail: string;
};

export const setupSteps: SetupStep[] = [
  {
    id: "prerequisites",
    number: "01",
    title: "Check the prerequisites",
    summary: "VS Code 1.90+, audio tools for Knowledge Check, and an available ACP agent.",
    status: "verified",
    detail:
      "The extension currently requires VS Code 1.90 or newer. Microphone capture uses ffmpeg, and speaker playback works best with ffplay available. Provider credentials and an ACP-compatible agent are configured separately.",
  },
  {
    id: "install",
    number: "02",
    title: "Install the extension",
    summary: "A final public installation target has not been verified yet.",
    status: "placeholder",
    detail:
      "Installation copy and the final link belong here once a Marketplace listing, release artifact, or other supported distribution path is confirmed.",
  },
  {
    id: "agent",
    number: "03",
    title: "Choose an ACP agent",
    summary: "Refresh discovered agents, inspect availability, then select one for repository analysis.",
    status: "verified",
    detail:
      "CodeSensei reads the ACP registry and an optional local Windsurf registry. Agent-specific model, reasoning, mode, and sandbox options can be configured when the agent exposes them.",
  },
  {
    id: "voice",
    number: "04",
    title: "Configure voice providers",
    summary: "Choose realtime or chained voice mode and supply compatible endpoints.",
    status: "verified",
    detail:
      "Realtime mode uses one OpenAI-compatible WebSocket for speech and conversation. Chained mode separates speech-to-text, chat, and text-to-speech providers. Exact provider guidance will be expanded here later.",
  },
  {
    id: "audio",
    number: "05",
    title: "Test microphone and speaker",
    summary: "Use the extension’s built-in audio checks before starting.",
    status: "verified",
    detail:
      "The Home view includes microphone and speaker tests, audio-device selection, silence timing, and listening-beep controls so you can confirm the conversation loop before Knowledge Check.",
  },
  {
    id: "first-session",
    number: "06",
    title: "Create a guide or start Knowledge Check",
    summary: "Open a workspace, select an agent, then choose your learning path.",
    status: "verified",
    detail:
      "Code Tutor can write CODESENSEI.md with architecture, setup, key files, and safe first contributions. Knowledge Check opens relevant source ranges, asks you one focused question at a time, and stops when you ask or the configured question limit is reached.",
  },
];
