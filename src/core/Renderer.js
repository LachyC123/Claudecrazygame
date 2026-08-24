import * as THREE from 'three';
import { cfg } from './Config.js';

export function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, powerPreference: 'high-performance',
    stencil: false, depth: true, alpha: false,
    preserveDrawingBuffer: cfg.capture,
  });
  renderer.setPixelRatio(cfg.pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = cfg.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = true;
  container.appendChild(renderer.domElement);
  return renderer;
}
