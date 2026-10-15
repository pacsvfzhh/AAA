export default function LoginDecorations() {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {/* Soft light-blue-to-white gradient in corners */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse at 85% 10%, rgba(191,219,254,0.3) 0%, rgba(219,234,254,0.1) 30%, transparent 55%),
            radial-gradient(ellipse at 10% 90%, rgba(191,219,254,0.2) 0%, transparent 40%)
          `,
        }}
      />

      {/* Gentle top edge: light blue fading down to white */}
      <div
        className="absolute top-0 left-0 right-0 h-[250px]"
        style={{
          background: 'linear-gradient(180deg, rgba(219,234,254,0.3) 0%, rgba(239,246,255,0.1) 60%, transparent 100%)',
        }}
      />

      {/* Very subtle diagonal gradient sweep */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(120deg, transparent 20%, rgba(191,219,254,0.08) 45%, rgba(219,234,254,0.06) 55%, transparent 80%)',
        }}
      />

      {/* Large half-globe - top right, cropped to show only left half */}
      <svg
        className="absolute top-[-8%] right-[-12%] w-[55vw] h-[55vw] max-w-[750px] max-h-[750px]"
        viewBox="0 0 600 600"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ animation: 'float-slow 40s ease-in-out infinite' }}
      >
        <defs>
          <linearGradient id="globe-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgb(96 165 250)" stopOpacity="0.4" />
            <stop offset="50%" stopColor="rgb(59 130 246)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(37 99 235)" stopOpacity="0.2" />
          </linearGradient>
          <radialGradient id="globe-fill" cx="40%" cy="35%" r="60%">
            <stop offset="0%" stopColor="rgb(191 219 254)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="rgb(219 234 254)" stopOpacity="0.03" />
          </radialGradient>
        </defs>
        {/* Outer glow */}
        <circle cx="300" cy="300" r="290" fill="none" stroke="rgb(147 197 253 / 0.18)" strokeWidth="1" />
        <circle cx="300" cy="300" r="280" fill="url(#globe-fill)" />
        {/* Main globe circle */}
        <circle cx="300" cy="300" r="260" stroke="url(#globe-gradient)" strokeWidth="2.5" fill="none" />
        <circle cx="300" cy="300" r="258" stroke="rgb(191 219 254 / 0.15)" strokeWidth="6" fill="none" />
        {/* Longitude lines */}
        <ellipse cx="300" cy="300" rx="180" ry="260" stroke="rgb(147 197 253 / 0.22)" strokeWidth="1.5" fill="none" />
        <ellipse cx="300" cy="300" rx="100" ry="260" stroke="rgb(147 197 253 / 0.17)" strokeWidth="1.2" fill="none" />
        <ellipse cx="300" cy="300" rx="40" ry="260" stroke="rgb(147 197 253 / 0.12)" strokeWidth="1" fill="none" />
        <ellipse cx="300" cy="300" rx="230" ry="260" stroke="rgb(147 197 253 / 0.14)" strokeWidth="1" fill="none" />
        {/* Latitude lines */}
        <ellipse cx="300" cy="300" rx="260" ry="60" stroke="rgb(147 197 253 / 0.2)" strokeWidth="1.2" fill="none" />
        <ellipse cx="300" cy="200" rx="220" ry="45" stroke="rgb(147 197 253 / 0.16)" strokeWidth="1" fill="none" />
        <ellipse cx="300" cy="400" rx="220" ry="45" stroke="rgb(147 197 253 / 0.16)" strokeWidth="1" fill="none" />
        <ellipse cx="300" cy="150" rx="170" ry="30" stroke="rgb(147 197 253 / 0.12)" strokeWidth="1" fill="none" />
        <ellipse cx="300" cy="450" rx="170" ry="30" stroke="rgb(147 197 253 / 0.12)" strokeWidth="1" fill="none" />
        {/* Trade route arcs */}
        <path d="M120 250 Q220 180 350 220" stroke="rgb(59 130 246 / 0.35)" strokeWidth="2" fill="none" strokeDasharray="8 5" />
        <path d="M180 380 Q300 320 450 360" stroke="rgb(59 130 246 / 0.3)" strokeWidth="2" fill="none" strokeDasharray="8 5" />
        <path d="M200 180 Q350 140 480 200" stroke="rgb(96 165 250 / 0.25)" strokeWidth="1.5" fill="none" strokeDasharray="6 4" />
        {/* Route nodes with gradient glow */}
        <circle cx="120" cy="250" r="6" fill="rgb(59 130 246 / 0.15)" />
        <circle cx="120" cy="250" r="4" fill="rgb(59 130 246 / 0.45)" />
        <circle cx="350" cy="220" r="6" fill="rgb(59 130 246 / 0.15)" />
        <circle cx="350" cy="220" r="4" fill="rgb(59 130 246 / 0.45)" />
        <circle cx="180" cy="380" r="5" fill="rgb(96 165 250 / 0.12)" />
        <circle cx="180" cy="380" r="3.5" fill="rgb(96 165 250 / 0.35)" />
        <circle cx="450" cy="360" r="5" fill="rgb(96 165 250 / 0.12)" />
        <circle cx="450" cy="360" r="3.5" fill="rgb(96 165 250 / 0.35)" />
        <circle cx="200" cy="180" r="4" fill="rgb(96 165 250 / 0.1)" />
        <circle cx="200" cy="180" r="2.5" fill="rgb(96 165 250 / 0.3)" />
        <circle cx="480" cy="200" r="4" fill="rgb(96 165 250 / 0.1)" />
        <circle cx="480" cy="200" r="2.5" fill="rgb(96 165 250 / 0.3)" />
        {/* Inner decorative ring */}
        <circle cx="300" cy="300" r="200" stroke="rgb(191 219 254 / 0.14)" strokeWidth="1" fill="none" strokeDasharray="4 8" />
        {/* Highlight arc on top-left edge */}
        <path d="M140 160 A260 260 0 0 1 300 42" stroke="rgb(96 165 250 / 0.5)" strokeWidth="3" fill="none" strokeLinecap="round" />
      </svg>

      {/* Gradient glow behind the globe */}
      <div
        className="absolute top-[-5%] right-[-8%] w-[45vw] h-[45vw] max-w-[650px] max-h-[650px] rounded-full blur-[100px]"
        style={{
          background: 'radial-gradient(circle, rgba(59,130,246,0.15) 0%, rgba(96,165,250,0.08) 40%, transparent 70%)',
        }}
      />

      {/* Container ship silhouette - bottom left */}
      <svg
        className="absolute bottom-[5%] left-[-2%] w-[350px] h-[200px] text-blue-300/25"
        viewBox="0 0 420 240"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ animation: 'float-slow 30s ease-in-out infinite' }}
      >
        <path
          d="M20 180 L40 180 L50 140 L90 140 L90 100 L130 100 L130 80 L170 80 L170 100 L210 100 L210 80 L250 80 L250 60 L270 60 L270 80 L310 80 L310 100 L350 100 L350 140 L380 140 L400 180 L20 180 Z"
          fill="currentColor"
        />
        <path d="M15 185 L405 185 L395 210 L25 210 Z" fill="currentColor" opacity="0.6" />
        <path d="M180 220 C220 225 280 225 320 220" stroke="currentColor" strokeWidth="2" opacity="0.3" />
      </svg>

      {/* Dotted trade route path */}
      <svg
        className="absolute top-[38%] left-0 w-[50%] h-[150px] text-blue-400/10"
        viewBox="0 0 600 150"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="none"
      >
        <path
          d="M0 80 C100 30 200 120 350 60 C450 20 550 100 600 50"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="10 7"
          opacity="0.8"
        />
        <circle cx="100" cy="50" r="4" fill="currentColor" opacity="0.6" />
        <circle cx="350" cy="60" r="4" fill="currentColor" opacity="0.6" />
      </svg>

      {/* Compass rose - bottom left area */}
      <svg
        className="absolute bottom-[22%] left-[18%] w-[100px] h-[100px] text-blue-300/15"
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ animation: 'float-slow 40s ease-in-out infinite', animationDelay: '15s' }}
      >
        <circle cx="60" cy="60" r="50" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="60" cy="60" r="40" stroke="currentColor" strokeWidth="1" opacity="0.6" />
        <polygon points="60,15 55,55 60,45 65,55" fill="currentColor" opacity="0.8" />
        <polygon points="60,105 55,65 60,75 65,65" fill="currentColor" opacity="0.5" />
        <polygon points="15,60 55,55 45,60 55,65" fill="currentColor" opacity="0.5" />
        <polygon points="105,60 65,55 75,60 65,65" fill="currentColor" opacity="0.5" />
      </svg>

      {/* Decorative rings */}
      <div
        className="absolute bottom-[12%] left-[8%] w-[220px] h-[220px] rounded-full border border-blue-200/15"
        style={{
          animation: 'float-slow 30s ease-in-out infinite',
          animationDelay: '5s',
        }}
      />
      <div
        className="absolute top-[55%] left-[25%] w-[140px] h-[140px] rounded-full border border-dashed border-blue-100/20"
        style={{
          animation: 'float-slow 35s ease-in-out infinite',
          animationDelay: '8s',
        }}
      />

      {/* Soft ambient glow - bottom left, light blue fading to white */}
      <div
        className="absolute bottom-[5%] left-[3%] w-[300px] h-[300px] rounded-full blur-[100px]"
        style={{
          background: 'radial-gradient(circle, rgba(191,219,254,0.25) 0%, rgba(219,234,254,0.1) 40%, transparent 70%)',
        }}
      />

      {/* Inline keyframes */}
      <style>{`
        @keyframes float-slow {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          50% { transform: translateY(-12px) rotate(1deg); }
        }
      `}</style>
    </div>
  );
}