# File to Playlist

![preview](preview.png)

Turn a CSV or M3U file into a Spotify playlist. Drop the file onto Spotify, check the matches, create the playlist.

A [Spicetify](https://spicetify.app) extension.

> The preview above is an illustration of the import screen, not a screenshot.

## ✨ Features

- **Drag and drop.** Drop a `.csv` or `.m3u` file anywhere onto Spotify and the importer opens with it. Or use **Import playlist from file** in the profile menu.
- **Finds every song on Spotify** and shows how sure it is:
  - 🟢 **Matched**
  - 🟠 **Check this**: a best guess worth a look
  - 🔴 **Not found**
- **Pick a different match** from a dropdown of up to five Spotify results per song, or untick songs you don't want.
- **Uses song lengths** from M3U files to pick the right version of a track.
- **Spotify links in the file are used directly**, without searching.
- **Skips duplicates** if you want.
- **Nothing changes until you press Create.** When it's done, **Open playlist** takes you straight there.

## 📄 Supported files

| Format | What it reads |
| ------ | ------------- |
| **M3U / M3U8** | `#EXTINF` lines (`Artist - Title` and length), `#PLAYLIST` names, file names like `Artist - Title.mp3`, and Spotify track links |
| **CSV / TSV** | A header row with a title column and ideally an artist column. Common names work: `Title`, `Track Name`, `Song`, `Artist`, `Artist Name(s)`, `Album`, `Duration (ms)`, `Spotify URI`. Commas, semicolons and tabs are all fine |

Exports from YouTube Music tools, Exportify and most music players work as they are. Multiple artists can be separated with `;`, `,`, `&` or `feat.`.

## 📦 Install

### Marketplace

Open the [Spicetify Marketplace](https://github.com/spicetify/marketplace), search for **File to Playlist** and click install.

### Manual

1. Download [`fileToPlaylist.js`](fileToPlaylist.js) into your Spicetify `Extensions` folder.

   | Platform        | Path                              |
   | --------------- | --------------------------------- |
   | **Windows**     | `%appdata%\spicetify\Extensions\` |
   | **Linux/macOS** | `~/.config/spicetify/Extensions/` |

2. Run:

   ```
   spicetify config extensions fileToPlaylist.js
   spicetify apply
   ```

## 🎵 Usage

1. Drag a CSV or M3U file onto Spotify, or open **Import playlist from file** from the profile menu.
2. Check the name and the matches. Amber rows are worth a look; pick another match from the dropdown or untick the song.
3. Press **Create playlist**.

> [!TIP]
> Songs that only exist on YouTube (fan edits, sped-up versions, unofficial remixes) usually aren't on Spotify and will show as not found. That's expected.

## 🗑️ Uninstall

Remove it from the Marketplace **Installed** tab, or for a manual install run:

```
spicetify config extensions fileToPlaylist.js-
spicetify apply
```

> [!NOTE]
> Built for Spotify 1.3.5 with Spicetify 2.45.3. Searching uses your own Spotify session, three songs at a time, so a long file takes a minute or two. If something doesn't work, please [open an issue](https://github.com/superC12/spicetify-file-to-playlist/issues) with your Spotify version.

## 📋 Changelog

### v1.0.0

- Initial release.

## License

[MIT](LICENSE)
