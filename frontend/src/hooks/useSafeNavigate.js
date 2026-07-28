import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

// Returns a navigate function that sanitizes string destinations to avoid open-redirects
export default function useSafeNavigate() {
  const navigate = useNavigate();

  return useCallback(
    (to, options) => {
      try {
        if (typeof to === 'string') {
          // Normalize backslashes to forward slashes
          let dest = to.replace(/\\/g, '/');

          // Disallow protocol-relative or absolute external redirects
          if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(dest) || dest.startsWith('//')) {
            console.warn('Blocked external navigation attempt:', dest);
            return;
          }

          // Ensure it is a path starting with /
          if (!dest.startsWith('/')) dest = '/' + dest;

          return navigate(dest, options);
        }

        // If called with location-like object, pass through (could validate more)
        return navigate(to, options);
      } catch (err) {
        // If sanitize or navigation fails, log and no-op
        console.error('safeNavigate error', err);
      }
    },
    [navigate]
  );
}
