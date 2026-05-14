import { ThemeProvider } from "@/components/ui/theme-provider";

export default function App({ children }) {
  const template = document.querySelector("#appShellTemplate");

  return (
    <ThemeProvider>
      {children ?? <div dangerouslySetInnerHTML={{ __html: template?.innerHTML.trim() || "" }} />}
    </ThemeProvider>
  );
}
