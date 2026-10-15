import { createRoot } from "react-dom/client";
import { AuthorStars } from "../../components/AuthorStars.js";
import "../../assets/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Author stars root element is missing");

createRoot(container).render(<AuthorStars />);
