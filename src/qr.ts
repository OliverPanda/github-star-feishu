import qrcode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";

/**
 * Render a QR code for the terminal.
 *
 * Half-block glyphs keep the code square instead of stretched, which is what
 * phone cameras need; `fallback` is always printed next to it because older
 * Windows consoles still mangle box-drawing output.
 */
export function renderTerminalQr(text: string): string {
  let rendered = "";
  qrcodeTerminal.generate(text, { small: true }, (code) => {
    rendered = code;
  });
  return rendered.trimEnd();
}

/** PNG data URL, so the options page can show the code without a file on disk. */
export async function renderQrDataUrl(text: string): Promise<string> {
  return qrcode.toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 320 });
}

export interface LoginQrBlockOptions {
  /** Headline shown above the code, e.g. 第 1 步：创建你的飞书应用. */
  title: string;
  /** Short instruction line. */
  instruction: string;
  url: string;
  userCode: string | null;
  expiresInSeconds: number | null;
  /**
   * Closing line under the code, which is where the two providers differ:
   * Feishu's link already carries the user code, GitHub's does not.
   */
  scanHint?: string;
}

/**
 * The full terminal prompt for one scan step.
 *
 * Chinese text is printed as-is; terminals are expected to be UTF-8, and the
 * plain URL below the code is the guaranteed-working path when they are not.
 */
export function formatLoginQrBlock(options: LoginQrBlockOptions): string {
  const lines = [`${options.title}`, "", options.instruction, "", renderTerminalQr(options.url)];
  if (options.userCode) lines.push(`  用户码：${options.userCode}`);
  lines.push(`  链接：${options.url}`);
  if (options.expiresInSeconds) {
    lines.push(`  有效期：${Math.round(options.expiresInSeconds / 60)} 分钟`);
  }
  lines.push(
    "",
    options.scanHint ?? "  用手机飞书扫码，或在浏览器打开上面的链接确认。",
  );
  return lines.join("\n");
}
