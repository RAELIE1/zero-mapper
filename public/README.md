# Public Assets Folder

This folder contains static assets served by the API landing page.

## Required Files

You need to add the following files to this folder:

### 1. `image.webp` or `image.jpg`
- Your profile picture or logo
- Will be displayed as a circular image (250x250px)
- Should be square for best results

### 2. `wlc.gif`
- A welcome animation GIF
- Will be displayed on left and right sides of the page (mirrored on right)
- Recommended size: 300x300px
- Example: Anime character waving or any welcoming animation

### 3. `favicon.ico`
- Browser tab icon
- Standard favicon (16x16 or 32x32px)

## File Structure

```
public/
├── index.html          ✅ (already created)
├── image.webp          ❌ (you need to add this)
├── wlc.gif             ❌ (you need to add this)
└── favicon.ico         ❌ (you need to add this)
```

## Where to Get Assets

- **Profile Image**: Use your GitHub profile picture or any anime character image
- **Welcome GIF**: Search for "anime wave gif" or "anime welcome gif" on Tenor or Giphy
- **Favicon**: Use a favicon generator like https://favicon.io or https://realfavicongenerator.net

## Testing

After adding the files, visit `http://localhost:3000/` to see your landing page!

The page will show:
- Your title at the top
- Profile picture in the center
- GitHub link (update the href in index.html)
- List of available API routes
- Welcome GIFs on the sides (hidden on mobile)
