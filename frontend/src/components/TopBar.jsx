
import React, { useState, useEffect } from "react";
import { NavLink as RouterNavLink, useNavigate, Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import {
  Bars3Icon,
  XMarkIcon,
  ChevronDownIcon,
} from "@heroicons/react/24/outline";
import inventeLogo from "../assets/invente.png";

// A small helper component to avoid repeating the role check logic

const NavLink = ({ to, children, requiredRoles = null, user, className = "" }) => {
  // Every navigation item is authenticated; role arrays further restrict the item.
  const isVisible = Boolean(user) && (!requiredRoles || requiredRoles.includes(user.role));

  if (!isVisible) {
    return null;
  }

  return (
    <Link to={to} className={`hover:text-blue-600 transition-colors ${className}`}>
      {children}
    </Link>
  );
};

export default function TopBar() {
  const { user, logout, authAxios } = useAuth();
  const navigate = useNavigate();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [eventAdminHasTechEvent, setEventAdminHasTechEvent] = useState(true); // Default to true to show scan initially

  // Fetch event details for event_admin users to determine if they should see scan option
  useEffect(() => {
    const checkEventType = async () => {
      if (user?.role === 'event_admin' && user?.event_id) {
        try {
          const response = await authAxios.get('/events');
          const events = response.data.rows || [];
          const userEvent = events.find(event => event.external_id === user.event_id);
          if (userEvent) {
            setEventAdminHasTechEvent(userEvent.event_type === 'technical');
          }
        } catch (error) {
          console.error('Failed to fetch event details:', error);
          // On error, default to true to avoid breaking existing functionality
          setEventAdminHasTechEvent(true);
        }
      }
    };

    checkEventType();
  }, [user, authAxios]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const displayRole = String(user?.role || user?.primary_role || user?.roles?.[0] || 'Staff')
    .replaceAll('_', ' ');

  // Define roles for clarity and to reduce repetition
  const registrationRoles = ["volunteer", "super_admin", "master_admin"];
  const workshopRegistrationRoles = ["volunteer", "super_admin", "master_admin", "workshop_admin", "workshop_volunteer"];
  const nonTechRegistrationRoles = ["volunteer", "super_admin", "master_admin", "dept_admin"];
  const attendanceRoles = ["event_admin", "super_admin", "master_admin"];
  const analyticsRoles = ["event_admin", "dept_admin", "super_admin", "master_admin", "workshop_admin"];
  
  // Conditionally include event_admin in scan roles based on their event type
  const baseScanRoles = ["volunteer", "dept_admin", "super_admin", "master_admin"];
  const scanRoles = user?.role === 'event_admin' 
    ? (eventAdminHasTechEvent ? [...baseScanRoles, "event_admin"] : baseScanRoles)
    : [...baseScanRoles, "event_admin"];

  // The navigation links are defined once and reused for both desktop and mobile views
  const navLinks = (
    <>
      <NavLink to="/" user={user}>Home</NavLink>
      <NavLink to="/scan" requiredRoles={scanRoles} user={user}>Scan</NavLink>
      <NavLink to="/attendance" requiredRoles={attendanceRoles} user={user}>Attendance</NavLink>
      <NavLink to="/analytics" requiredRoles={analyticsRoles} user={user}>Analytics</NavLink>
      <NavLink to="/tech-registration" requiredRoles={registrationRoles} user={user}>Tech Registration</NavLink>
      <NavLink to="/workshop-registration" requiredRoles={workshopRegistrationRoles} user={user}>Workshop Registration</NavLink>
      <NavLink to="/non-tech-registration" requiredRoles={nonTechRegistrationRoles} user={user}>Non-Tech Registration</NavLink>
      <NavLink to="/receipt-review" user={user}>Receipt Verification</NavLink>
    </>
  );

  return (
    <header className="bg-white shadow-md sticky top-0 z-50">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        {/* Left Side: Logo */}
        <Link to="/" className="flex items-center">
          <img 
            src={inventeLogo} 
            alt="Invente'25 Admin" 
            className="h-8 w-auto"
          />
        </Link>

        {/* Center: Desktop Navigation */}
        <nav className="hidden items-center space-x-6 text-sm font-medium text-gray-600 md:flex">
          {navLinks}
        </nav>

        {/* Right Side: User Info & Actions */}
        <div className="flex items-center space-x-4">
          {user ? (
            <div className="hidden items-center space-x-4 md:flex">
              <div className="text-right text-sm">
                <div className="font-medium text-gray-800">{user.email}</div>
                <div className="text-xs capitalize text-gray-500">{displayRole}</div>
              </div>
              <button
                onClick={handleLogout}
                className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-600"
              >
                Logout
              </button>
            </div>
          ) : (
            <Link
              to="/login"
              className="hidden rounded-md bg-blue-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-600 md:block"
            >
              Login
            </Link>
          )}

          {/* Mobile Menu Button */}
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 md:hidden"
            aria-label="Toggle menu"
          >
            {isMenuOpen ? (
              <XMarkIcon className="h-6 w-6" />
            ) : (
              <Bars3Icon className="h-6 w-6" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile Menu Dropdown */}
      {isMenuOpen && (
        <div className="border-t border-gray-200 bg-white md:hidden">
          <nav className="flex flex-col space-y-4 p-4 text-base">
            {navLinks}
          </nav>
          <div className="border-t border-gray-200 p-4">
            {user ? (
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <div className="font-medium text-gray-800">{user.email}</div>
                  <div className="text-xs capitalize text-gray-500">{displayRole}</div>
                </div>
                <button
                  onClick={handleLogout}
                  className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-600"
                >
                  Logout
                </button>
              </div>
            ) : (
              <Link
                to="/login"
                className="block w-full rounded-md bg-blue-500 px-4 py-2 text-center font-semibold text-white shadow-sm hover:bg-blue-600"
              >
                Login
              </Link>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
