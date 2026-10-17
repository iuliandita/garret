notes.docx was written by LibreOffice 26.8.1.1 from notes.fodt.
It is not a Microsoft Word fixture. Native Word qualification remains external.

The fixture has two footnotes, one endnote, italic and bold runs, two paragraphs
in the first footnote, and a drawing in the endnote. Import retains three owned
plain-text notes. Paragraph/run formatting affects three notes; one note loses
drawings; no note body is missing. Separator records are excluded.

Regenerate in an isolated office profile:
soffice --headless --convert-to 'docx:Office Open XML Text' notes.fodt
