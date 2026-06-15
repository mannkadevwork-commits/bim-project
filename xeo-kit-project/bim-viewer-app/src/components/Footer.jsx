import { Info } from 'lucide-react';

const Footer = () => {
  return (
    <footer className="fixed bottom-0 left-0 w-full z-40 bg-white/70 dark:bg-slate-900/70 backdrop-blur-xl border-t border-white/20 dark:border-slate-800 transition-colors duration-300">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-12 text-sm">
          
          {/* Animated System Status */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-emerald-500 dark:text-emerald-400 font-medium">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
              <span>System Online</span>
            </div>
            <span className="hidden md:inline text-slate-500 dark:text-slate-500 font-mono text-xs">
              v2.0.0-pro
            </span>
          </div>

          <div className="hidden sm:block text-slate-500 dark:text-slate-400 font-medium">
            &copy; {new Date().getFullYear()} XeoVision Pro. All rights reserved.
          </div>

          <div className="flex items-center gap-4">
            <button className="text-slate-400 hover:text-indigo-500 transition-colors"><Info className="w-4 h-4" /></button>
            <a href="#" className="text-slate-400 hover:text-indigo-500 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"/></svg>
            </a>
            <a href="#" className="text-slate-400 hover:text-indigo-500 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
            </a>
          </div>

        </div>
      </div>
    </footer>
  );
};
export default Footer;