import { useEffect, useRef, useState } from 'react';
import { useDeviceOptimization } from '../lib/useDeviceOptimization';

export default function BlockchainBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { tier, isLowEnd } = useDeviceOptimization();
  const [isReady, setIsReady] = useState(false);
  const [isMobile, setIsMobile] = useState(() => {
    return window.innerWidth < 768 ||
           /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  });
  const [isTabletDevice, setIsTabletDevice] = useState(() => {
    return window.innerWidth >= 768 && window.innerWidth <= 1024;
  });
  const [isLowPerformance, setIsLowPerformance] = useState(false);
  const fpsCounterRef = useRef({ frames: 0, lastTime: 0, fps: 60 });

  useEffect(() => {
    const checkDevices = () => {
      const mobile = window.innerWidth < 768 ||
                     /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      const tablet = window.innerWidth >= 768 && window.innerWidth <= 1024;
      setIsMobile(mobile);
      setIsTabletDevice(tablet);
    };

    const timer = setTimeout(() => setIsReady(true), 100);
    checkDevices();
    window.addEventListener('resize', checkDevices);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', checkDevices);
    };
  }, []);

  useEffect(() => {
    let checkCount = 0;
    const maxChecks = 60;
    const lowFpsThreshold = 45;
    let totalFps = 0;

    const checkPerformance = () => {
      if (checkCount >= maxChecks) return;
      const currentFps = fpsCounterRef.current.fps;
      totalFps += currentFps;
      checkCount++;
      if (checkCount === maxChecks) {
        const averageFps = totalFps / maxChecks;
        if (averageFps < lowFpsThreshold) setIsLowPerformance(true);
      }
      if (checkCount < maxChecks) requestAnimationFrame(checkPerformance);
    };

    const timeoutId = setTimeout(() => requestAnimationFrame(checkPerformance), 1000);
    return () => clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!isReady) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const setCanvasSize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    setCanvasSize();

    interface Particle {
      x: number; y: number;
      vx: number; vy: number;
      size: number; opacity: number;
      pulseSpeed: number; pulsePhase: number;
      color: string;
    }

    const particles: Particle[] = [];
    let particleCount = 40;
    let maxDistance = 160;

    if (isLowEnd || tier === 'low') {
      particleCount = 0; maxDistance = 0;
    } else if (tier === 'mid') {
      particleCount = 15; maxDistance = 110;
    } else if (isLowPerformance) {
      particleCount = 10; maxDistance = 90;
    }

    if (isMobile) particleCount = Math.min(particleCount, 8);
    if (isTabletDevice) { particleCount = 0; maxDistance = 0; }

    const colors = [
      'rgba(37, 99, 235, ',
      'rgba(59, 130, 246, ',
      'rgba(96, 165, 250, ',
      'rgba(147, 197, 253, ',
      'rgba(29, 78, 216, ',
    ];

    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        size: Math.random() * 2 + 1,
        opacity: Math.random() * 0.25 + 0.1,
        pulseSpeed: Math.random() * 0.015 + 0.01,
        pulsePhase: Math.random() * Math.PI * 2,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }

    let animationFrame: number;
    let lastFrameTime = 0;
    let targetFPS = 60;
    if (isLowEnd || tier === 'low') targetFPS = 20;
    else if (tier === 'mid' || isMobile || isTabletDevice) targetFPS = 30;
    else if (isLowPerformance) targetFPS = 40;
    const frameInterval = 1000 / targetFPS;

    const animate = (currentTime: number = 0) => {
      const deltaTime = currentTime - lastFrameTime;

      if (currentTime - fpsCounterRef.current.lastTime >= 1000) {
        fpsCounterRef.current.fps = fpsCounterRef.current.frames;
        fpsCounterRef.current.frames = 0;
        fpsCounterRef.current.lastTime = currentTime;
      }
      fpsCounterRef.current.frames++;

      if (deltaTime < frameInterval) {
        animationFrame = requestAnimationFrame(animate);
        return;
      }
      lastFrameTime = currentTime;

      ctx.fillStyle = 'rgba(249, 250, 251, 0.12)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width)  p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

        p.pulsePhase += p.pulseSpeed;
        const pulse = Math.sin(p.pulsePhase) * 0.3 + 0.7;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * pulse, 0, Math.PI * 2);
        ctx.fillStyle = `${p.color}${p.opacity * pulse})`;
        ctx.fill();

        if (!isMobile && !isTabletDevice && !isLowPerformance) {
          const glowSize = p.size * 4 * pulse;
          const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowSize);
          gradient.addColorStop(0, `${p.color}${p.opacity * 0.3 * pulse})`);
          gradient.addColorStop(0.5, `${p.color}${p.opacity * 0.1 * pulse})`);
          gradient.addColorStop(1, 'rgba(59, 130, 246, 0)');
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(p.x, p.y, glowSize, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < maxDistance) {
            const opacity = (1 - distance / maxDistance) * 0.12;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(59, 130, 246, ${opacity})`;
            ctx.lineWidth = 0.8;
            ctx.stroke();
          }
        }
      }

      animationFrame = requestAnimationFrame(animate);
    };

    animate();
    window.addEventListener('resize', setCanvasSize);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', setCanvasSize);
    };
  }, [isMobile, isTabletDevice, isLowPerformance, tier, isLowEnd, isReady]);

  const useReducedEffects = isMobile || isTabletDevice || isLowPerformance || isLowEnd || tier === 'low' || tier === 'mid';

  return (
    <>
      {/* White base with soft blue gradient edges */}
      <div
        className="fixed inset-0 -z-10"
        style={{
          background: '#ffffff',
          willChange: 'auto',
          transform: 'translateZ(0)',
        }}
      />

      {/* Light blue gradient fading into white - top-right corner */}
      <div
        className="fixed inset-0 -z-10"
        style={{
          background: 'radial-gradient(ellipse at 100% 0%, rgba(191,219,254,0.4) 0%, rgba(219,234,254,0.2) 25%, transparent 55%)',
        }}
      />

      {/* Light blue gradient fading into white - bottom-left corner */}
      <div
        className="fixed inset-0 -z-10"
        style={{
          background: 'radial-gradient(ellipse at 0% 100%, rgba(191,219,254,0.3) 0%, rgba(224,239,254,0.15) 20%, transparent 50%)',
        }}
      />

      {/* Subtle top-to-bottom gradient: light blue top edge fading to white */}
      <div
        className="fixed inset-0 -z-10"
        style={{
          background: 'linear-gradient(180deg, rgba(219,234,254,0.35) 0%, rgba(239,246,255,0.15) 15%, transparent 35%)',
        }}
      />

      {/* Subtle bottom edge: light blue fading up into white */}
      <div
        className="fixed inset-0 -z-10"
        style={{
          background: 'linear-gradient(0deg, rgba(219,234,254,0.25) 0%, rgba(239,246,255,0.1) 12%, transparent 30%)',
        }}
      />

      {/* Soft floating blue glow spots that blend into white */}
      {!useReducedEffects && (
        <div className="fixed inset-0 -z-10 overflow-hidden">
          <div
            className="absolute w-[600px] h-[600px] rounded-full"
            style={{
              top: '-5%',
              right: '5%',
              background: 'radial-gradient(circle, rgba(147,197,253,0.15) 0%, rgba(191,219,254,0.06) 40%, transparent 70%)',
              animation: 'soft-pulse 10s ease-in-out infinite',
            }}
          />
          <div
            className="absolute w-[500px] h-[500px] rounded-full"
            style={{
              bottom: '0%',
              left: '0%',
              background: 'radial-gradient(circle, rgba(147,197,253,0.12) 0%, rgba(191,219,254,0.05) 40%, transparent 65%)',
              animation: 'soft-pulse 12s ease-in-out infinite 3s',
            }}
          />
          <div
            className="absolute w-[400px] h-[400px] rounded-full"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              background: 'radial-gradient(circle, rgba(191,219,254,0.08) 0%, transparent 60%)',
              animation: 'soft-pulse 14s ease-in-out infinite 5s',
            }}
          />
        </div>
      )}

      {/* Canvas particles */}
      {!isMobile && !isTabletDevice && (
        <canvas
          ref={canvasRef}
          className={`fixed inset-0 -z-10 ${useReducedEffects ? 'opacity-40' : 'opacity-60'}`}
        />
      )}

      {/* Subtle dot grid pattern */}
      <div
        className="fixed inset-0 -z-10 opacity-[0.02]"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(37,99,235,0.8) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      {/* Inline animation keyframes */}
      <style>{`
        @keyframes soft-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </>
  );
}
