import { createRoot } from "react-dom/client";
import { TrendingList } from "../../components/TrendingList.js";
import "../../assets/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Trending root element is missing");

createRoot(container).render(<TrendingList />);
