import { createRoot } from "react-dom/client";
import "../../assets/styles.css";
import { WeeklyMoneyList } from "../../components/WeeklyMoneyList.js";

const container = document.getElementById("root");
if (!container) throw new Error("Weekly money root element is missing");

createRoot(container).render(<WeeklyMoneyList />);
