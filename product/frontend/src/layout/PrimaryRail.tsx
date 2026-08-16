import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { firstReleaseHiddenPrimaryPathSet } from "../app/release-surface";
import { primaryRoutes } from "../app/routes";

export function PrimaryRail() {
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [activeMoreIndex, setActiveMoreIndex] = useState(0);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 680);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreItemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const visibleRoutes = primaryRoutes.filter((route) =>
    !firstReleaseHiddenPrimaryPathSet.has(route.path),
  );
  const directRoutes = visibleRoutes.slice(0, 4);
  const moreRoutes = visibleRoutes.slice(4);

  useEffect(() => {
    const updateViewport = () => {
      const mobile = window.innerWidth <= 680;
      setIsMobile(mobile);
      if (!mobile) setMoreOpen(false);
    };
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => setMoreOpen(false), [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    moreItemRefs.current[0]?.focus();
    const isOutside = (target: Node) =>
      !moreButtonRef.current?.contains(target) && !moreMenuRef.current?.contains(target);
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (isOutside(target)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [moreOpen]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setMoreOpen(false);
      moreButtonRef.current?.focus();
      return;
    }

    const currentIndex = moreItemRefs.current.indexOf(document.activeElement as HTMLAnchorElement);
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % moreRoutes.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + moreRoutes.length) % moreRoutes.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = moreRoutes.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    setActiveMoreIndex(nextIndex);
    moreItemRefs.current[nextIndex]?.focus();
  };

  return (
    <nav className="primary-rail" aria-label="主导航">
      {(isMobile ? directRoutes : visibleRoutes).map(({ path, label, icon: Icon }) => (
        <Link key={path} className={`rail-link route-${label}${pathname === path ? " active" : ""}`} to={path} aria-current={pathname === path ? "page" : undefined}>
          <Icon aria-hidden="true" /><span>{label}</span>
        </Link>
      ))}
      {isMobile ? <button ref={moreButtonRef} className={`rail-link mobile-more${moreOpen ? " active" : ""}`} type="button" aria-label="更多" aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => {
        setActiveMoreIndex(0);
        setMoreOpen((open) => !open);
      }}>
        <MoreHorizontal aria-hidden="true" /><span>更多</span>
      </button> : null}
      {moreOpen ? (
        <div ref={moreMenuRef} className="more-menu" role="menu" aria-label="更多导航" onKeyDown={onMenuKeyDown} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMoreOpen(false);
        }}>
          {moreRoutes.map(({ path, label, icon: Icon }, index) => (
            <Link ref={(node) => { moreItemRefs.current[index] = node; }} key={path} role="menuitem" tabIndex={index === activeMoreIndex ? 0 : -1} to={path} aria-label={label} onClick={() => setMoreOpen(false)}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
