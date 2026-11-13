import { nanoid } from "nanoid";
import "./style.css";
import payloadUrl from "./payload.bin?url";
const app = document.querySelector<HTMLDivElement>("#app")!;
app.textContent = `VZ fixture ${nanoid(6)}`;
const button = document.createElement("button");
button.textContent = "Load a dynamic module";
button.addEventListener("click", async () => {
  const { message } = await import("./lazy.ts");
  app.textContent = message;
});
app.append(button);

const download = document.createElement("a");
download.href = payloadUrl;
download.textContent = "Binary fixture";
app.append(download);
