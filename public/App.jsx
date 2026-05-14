export default function App() {
  const template = document.querySelector("#appShellTemplate");

  return <div dangerouslySetInnerHTML={{ __html: template?.innerHTML.trim() || "" }} />;
}
