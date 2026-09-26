import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
const RouterContext = createContext({
  path: "/",
  navigate: (_path: string) => {},
});
export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return (
    <RouterContext.Provider
      value={{
        path,
        navigate: (target) => {
          if (target === location.pathname) return;
          history.pushState({}, "", target);
          setPath(target);
        },
      }}
    >
      {children}
    </RouterContext.Provider>
  );
}
export const useRouter = () => useContext(RouterContext);
export function Link({
  href,
  onClick,
  ...props
}: ComponentProps<"a"> & { href: string }) {
  const { navigate } = useRouter();
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          event.button === 0 &&
          href.startsWith("/")
        ) {
          event.preventDefault();
          navigate(href);
        }
      }}
    />
  );
}
