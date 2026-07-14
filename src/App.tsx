import { ReactFlowProvider } from "@xyflow/react";
import { Canvas } from "./components/canvas/Canvas";
import "./App.css";

function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}

export default App;
