import { Link } from 'react-router-dom';
import { HiPlus } from 'react-icons/hi';
import { FiAperture, FiUser, FiLogOut, FiLogIn, FiUserPlus } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

function Navbar() {
  const { user, logout } = useAuth();

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-logo" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <FiAperture size={28} color="#38bdf8" /> ZYLO
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
              <button className="btn btn-secondary btn-sm" onClick={logout} title="Sign out">
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
