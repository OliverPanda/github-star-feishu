import { createRoot } from "react-dom/client";
import { Options } from "../../components/Options.js";
import "../../assets/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Options root element is missing");

createRoot(container).render(<Options />);
