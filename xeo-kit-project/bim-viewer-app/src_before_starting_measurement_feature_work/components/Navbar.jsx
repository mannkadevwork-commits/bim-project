import { useState, useEffect } from 'react';
import { Menu, X, Sun, Moon } from 'lucide-react';

const Navbar = ({onOpenUpload, onOpenContact}) => {
  const [isOpen, setIsOpen] = useState(false);
  
  // Defaulting to dark mode since it looks better for 3D viewers
  const [isDark, setIsDark] = useState(true); 

  // Apply the dark class to the HTML root when toggled
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  return (
    <nav className="fixed top-0 left-0 w-full z-50 bg-white/70 dark:bg-gray-900/70 backdrop-blur-md border-b border-gray-200 dark:border-gray-800 transition-colors duration-300">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          
          {/* Logo Section */}
          <div className="flex items-center gap-2 cursor-pointer">
            <img
              src="/hci-logo.svg"
              alt="High Creation Interiors"
              className="hci-logo-badge hci-logo-badge--nav"
            />
            <div className="leading-tight">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-[#ff914d]">High Creation</span>
              <span className="block text-lg font-bold text-gray-900 dark:text-white tracking-wide">Interior BIM</span>
            </div>
          </div>

          {/* Desktop Links (Hidden on mobile) */}
          <div className="hidden md:flex space-x-8">
            <button onClick={onOpenUpload} className="text-slate-700 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-cyan-400 font-medium transition-colors">Models</button>
            {/* <a href="#" className="text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 font-medium transition-colors">Models</a> */}
            <a href="#" className="text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 font-medium transition-colors">Projects</a>
            <a href="#" className="text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 font-medium transition-colors">Settings</a>
          </div>

          {/* Right Section: Theme Toggle & Hamburger */}
          <div className="flex items-center gap-2">
            <button 
      onClick={onOpenContact}
      className="hidden sm:block bg-[#ff914d] hover:bg-[#ff7a28] text-white px-5 py-2 rounded-lg font-medium shadow-md shadow-[0_8px_20px_rgba(255,145,77,0.22)] transition-all"
    >
      Get in Touch
    </button>
            {/* Theme Toggle Button */}
            <button
              onClick={() => setIsDark(!isDark)}
              className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 transition-colors"
              aria-label="Toggle Dark Mode"
            >
              {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>

            {/* Mobile Hamburger Menu Button */}
            <button
              onClick={() => setIsOpen(!isOpen)}
              className="md:hidden p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 transition-colors"
            >
              {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Dropdown Menu */}
      {isOpen && (
        <div className="md:hidden bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 pt-2 pb-4 space-y-1 shadow-lg transition-colors duration-300">
          <a href="#" className="block px-3 py-2 rounded-md text-base font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">Models</a>
          <a href="#" className="block px-3 py-2 rounded-md text-base font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">Projects</a>
          <a href="#" className="block px-3 py-2 rounded-md text-base font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">Settings</a>
        </div>
      )}
    </nav>
  );
};

export default Navbar;