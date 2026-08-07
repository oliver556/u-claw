import { MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { primaryRoutes } from "../app/routes";

export function PrimaryRail() {
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 680);
  const directRoutes = primaryRoutes.slice(0, 4);
  const moreRoutes = primaryRoutes.slice(4);

  useEffect(() => {
    const updateViewport = () => setIsMobile(window.innerWidth <= 680);
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  const toggleFromKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setMoreOpen((open) => !open);
    }
  };

  return (
    <nav className="primary-rail" aria-label="主导航">
      {(isMobile ? directRoutes : primaryRoutes).map(({ path, label, icon: Icon }) => (
        <Link key={path} className={`rail-link route-${label}${pathname === path ? " active" : ""}`} to={path} aria-current={pathname === path ? "page" : undefined}>
          <Icon aria-hidden="true" /><span>{label}</span>
        </Link>
      ))}
      {isMobile ? <button className={`rail-link mobile-more${moreOpen ? " active" : ""}`} type="button" aria-label="更多" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)} onKeyDown={toggleFromKeyboard}>
        <MoreHorizontal aria-hidden="true" /><span>更多</span>
      </button> : null}
      {moreOpen ? (
        <div className="more-menu" role="menu" aria-label="更多导航">
          {moreRoutes.map(({ path, label, icon: Icon }) => (
            <Link key={path} role="menuitem" to={path} aria-label={label} onKeyDown={(event) => event.key === "Enter" && event.currentTarget.click()} onClick={() => setMoreOpen(false)}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
