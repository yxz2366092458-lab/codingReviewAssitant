import { execFile } from "node:child_process";

export function normalizePickedPath(text: string): string {
  return text.trim().replace(/\/$/, "");
}

export function chooseFolder(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "选择要登记的工程")'],
      { timeout: 5 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (error) {
          const message = `${stderr?.toString() ?? ""} ${error.message}`;
          if (message.includes("User canceled") || message.includes("-128")) {
            reject(new Error("已取消选择"));
            return;
          }
          reject(new Error("没有选到文件夹"));
          return;
        }
        const picked = normalizePickedPath(stdout.toString());
        if (!picked) {
          reject(new Error("没有选到文件夹"));
          return;
        }
        resolve(picked);
      },
    );
  });
}
