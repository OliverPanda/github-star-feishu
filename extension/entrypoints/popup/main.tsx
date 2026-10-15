import { createRoot } from "react-dom/client";
import { Popup } from "../../components/Popup.js";
import "../../assets/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Popup root element is missing");

createRoot(container).render(<Popup />);
