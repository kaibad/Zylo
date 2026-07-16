import { Link } from "react-router-dom";
import { HiPlus } from "react-icons/hi";
import { FiUser, FiLogOut, FiLogIn, FiUserPlus } from "react-icons/fi";
import { useAuth } from "../context/AuthContext";

function Navbar() {
  const { user, logout } = useAuth();

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-logo">
          <span className="navbar-logo-mark">Z</span>
          <span className="navbar-logo-text">Zylo</span>
        </Link>
        <div className="navbar-actions">
          {user ? (
            <>
              <span className="navbar-user">
                <FiUser size={14} />
                {user.username}
              </span>
              <Link to="/create" className="btn btn-primary">
                <HiPlus size={18} />
                <span>New Post</span>
              </Link>
              <button
                className="btn btn-secondary btn-sm"
                onClick={logout}
                title="Sign out"
              >
                <FiLogOut size={16} />
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn-secondary btn-sm">
                <FiLogIn size={16} />
                Sign In
              </Link>
              <Link to="/register" className="btn btn-primary">
                <FiUserPlus size={16} />
                Register
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

export default Navbar;
