import { createRoot } from "react-dom/client";
import { RosterList } from "../../components/RosterList.js";
import "../../assets/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Roster root element is missing");

createRoot(container).render(<RosterList />);
