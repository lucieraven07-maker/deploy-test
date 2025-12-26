
import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { Icosahedron, Sphere, Stars } from '@react-three/drei';
import * as THREE from 'three';

// -----------------------------------------------------------------------------
// The "Falcon Eye" Implementation
// -----------------------------------------------------------------------------

function Eye({ mouse }: { mouse: React.MutableRefObject<[number, number]> }) {
    const meshRef = useRef<THREE.Group>(null);

    // Outer Wireframe Shield
    const shieldRef = useRef<THREE.Mesh>(null);

    // Inner Glowing Core
    const coreRef = useRef<THREE.Mesh>(null);

    useFrame((state) => {
        if (!meshRef.current || !shieldRef.current || !coreRef.current) return;

        // 1. Constant Rotation (The "Living" aspect)
        shieldRef.current.rotation.y += 0.005;
        coreRef.current.rotation.x -= 0.01;
        coreRef.current.rotation.z += 0.005;

        // 2. Mouse Tracking (The "Watching" aspect)
        // Smoothly interpolate current rotation to look at mouse
        const targetX = mouse.current[0] * 1;
        const targetY = mouse.current[1] * 1;

        meshRef.current.rotation.x += (targetY - meshRef.current.rotation.x) * 0.1;
        meshRef.current.rotation.y += (targetX - meshRef.current.rotation.y) * 0.1;
    });

    return (
        <group ref={meshRef}>
            {/* Outer Wireframe Shield - "Falcon Eye" */}
            <Icosahedron args={[1.5, 2]} ref={shieldRef}>
                <meshStandardMaterial
                    color="#00ff9d"
                    wireframe
                    transparent
                    opacity={0.3}
                    emissive="#00ff9d"
                    emissiveIntensity={0.5}
                />
            </Icosahedron>

            {/* Inner Glowing Core - "Pupil" */}
            <Sphere args={[0.6, 32, 32]} ref={coreRef}>
                <meshStandardMaterial
                    color="#ffffff"
                    emissive="#00ff9d"
                    emissiveIntensity={2}
                    toneMapped={false}
                />
            </Sphere>

            {/* Ambient particles/glint */}
            <pointLight position={[10, 10, 10]} intensity={1.5} color="#00ff9d" />
            <pointLight position={[-10, -10, -10]} intensity={0.5} color="#ff00ff" />
        </group>
    );
}

function Scene() {
    const { mouse } = useThree();
    const mouseRef = useRef<[number, number]>([0, 0]);

    // Update mouse ref on move without re-rendering component
    useFrame((state) => {
        mouseRef.current = [state.mouse.x, state.mouse.y];
    });

    return (
        <>
            <color attach="background" args={['#050505']} />

            {/* Environment */}
            <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />

            {/* The Falcon Eye */}
            <Eye mouse={mouseRef} />

            {/* Post-Processing for "Glow" */}
            <EffectComposer disableNormalPass>
                <Bloom luminanceThreshold={0} mipmapBlur intensity={1.5} radius={0.8} />
            </EffectComposer>
        </>
    );
}

const FalconEye = ({ className }: { className?: string }) => {
    return (
        <div className={className}>
            <Canvas camera={{ position: [0, 0, 5], fov: 45 }} dpr={[1, 2]}>
                <Scene />
            </Canvas>
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent pointer-events-none" />
        </div>
    );
};

export default FalconEye;
