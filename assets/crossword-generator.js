// Constants
const VERSIONS = ['full', 'firstLetter', 'empty'];
const baseURL = 'https://crossword-server-aey0.onrender.com';

class CrosswordGenerator {
    constructor() {
        this.grid = null;
        this.wordData = [];
        this.GRID_SIZE = 20;
        this.placedWords = [];
        this.currentVersion = 0;
        // Bind methods that need 'this' context
        this.updateCrossword = this.updateCrossword.bind(this);
        this.saveCrossword = this.saveCrossword.bind(this);
        this.changeVersion = this.changeVersion.bind(this);
    }

    initializeControls() {
        const controls = {
            generateButton: document.getElementById('generate-button'),
            clearButton: document.getElementById('clear-button'),
            gridSizeInput: document.getElementById('grid-size'),
            wordCluesInput: document.getElementById('word-clues'),
            saveCrosswordButton: document.getElementById('saveCrossword')
        };

        if (controls.generateButton && controls.gridSizeInput && controls.wordCluesInput) {
            controls.generateButton.addEventListener('click', this.updateCrossword);

            if (controls.clearButton) {
                controls.clearButton.addEventListener('click', () => {
                    controls.wordCluesInput.value = '';
                    document.getElementById('crossword-grid').innerHTML = '';
                    document.getElementById('clues').innerHTML = '';
                });
            }

            controls.gridSizeInput.addEventListener('input', (e) => {
                let newSize = parseInt(e.target.value) || 20;
                if (window.innerWidth <= 768) {
                    newSize = Math.min(newSize, 20);
                    controls.gridSizeInput.value = newSize;
                }
                this.GRID_SIZE = newSize;
            });

            if (controls.saveCrosswordButton) {
                controls.saveCrosswordButton.addEventListener('click', this.saveCrossword);
            }
        }

        this.initializeVersionControl();
    }

    initializeVersionControl() {
        const prevButton = document.getElementById('prev-version');
        const nextButton = document.getElementById('next-version');

        if (prevButton) {
            prevButton.addEventListener('click', () => this.changeVersion(-1));
        }
        if (nextButton) {
            nextButton.addEventListener('click', () => this.changeVersion(1));
        }
    }

updateCrossword() {
    const input = document.getElementById('word-clues').value;
    
    // Parse input words and clues
    const newWordData = input.split('\n').map(line => {
        const parts = line.split(' - ');
        if (parts.length < 2) return null;
        const word = parts[0].trim().toUpperCase().replace(/ /g, '◼');
        const clue = parts[1].trim();
        return word && clue ? { word, clue } : null;
    }).filter(data => data);

    // Check if input has meaningfully changed
    const hasInputChanged = !this.wordData || 
        this.wordData.length !== newWordData.length ||
        newWordData.some((newData, index) => {
            const oldData = this.wordData[index];
            return newData.word !== oldData.word || newData.clue !== oldData.clue;
        });

    // If input has changed, update word data
    if (hasInputChanged) {
        this.wordData = newWordData;
    }

    // Always reset placed words and regenerate grid
    this.placedWords = [];
    this.grid = this.placeWordsInGrid(this.wordData);

    if (this.grid) {
        this.displayGrid(this.grid);
        this.displayClues();
        this.displayValidationWarnings(this.validatePersonalPuzzle(this.grid, this.placedWords));
        this.displayCurrentVersion();
    } else {
        this.displayError("Couldn't create a crossword with these words. Try adjusting the grid size or removing some words.");
    }
}
    parseWordsAndClues(input) {
        this.wordData = input.split('\n').map(line => {
            const parts = line.split(' - ');
            if (parts.length < 2) return null;
            const word = parts[0].trim().toUpperCase().replace(/ /g, '◼');
            const clue = parts[1].trim();
            return word && clue ? { word, clue } : null;
        }).filter(data => data);
    }

placeWordsInGrid(words) {
    // Sort words by length, with some randomization for same-length words
    words = [...words].sort((a, b) => {
        const lengthDiff = b.word.length - a.word.length;
        if (lengthDiff === 0) {
            return Math.random() - 0.5; // Slight randomization for words of same length
        }
        return lengthDiff;
    });

    const grid = Array.from({ length: this.GRID_SIZE }, () => Array(this.GRID_SIZE).fill(''));
    this.placedWords = [];

    for (const wordData of words) {
        if (!this.tryPlaceWord(grid, wordData)) {
            if (!this.backtrack(grid, words, wordData)) {
                return null;
            }
        }
    }

    return grid;
}

tryPlaceWord(grid, wordData) {
    // Try placing in center first
    const centerStart = Math.floor(this.GRID_SIZE / 4);
    const centerEnd = Math.floor(this.GRID_SIZE * 3 / 4);

    // Randomize orientation order
    const orientations = Math.random() > 0.5 ? [true, false] : [false, true];

    // First, try center area
    for (let row = centerStart; row <= centerEnd; row++) {
        for (let col = centerStart; col <= centerEnd; col++) {
            for (const horizontal of orientations) {
                if (this.canPlaceWord(grid, wordData.word, row, col, horizontal)) {
                    this.placeWord(grid, wordData, row, col, horizontal);
                    return true;
                }
            }
        }
    }

    // If center fails, try whole grid
    for (let row = 0; row < this.GRID_SIZE; row++) {
        for (let col = 0; col < this.GRID_SIZE; col++) {
            for (const horizontal of orientations) {
                if (this.canPlaceWord(grid, wordData.word, row, col, horizontal)) {
                    this.placeWord(grid, wordData, row, col, horizontal);
                    return true;
                }
            }
        }
    }

    return false;
}

    canPlaceWord(grid, word, row, col, horizontal) {
        if (horizontal && col + word.length > this.GRID_SIZE) return false;
        if (!horizontal && row + word.length > this.GRID_SIZE) return false;

        let hasIntersection = false;

        for (let i = 0; i < word.length; i++) {
            const r = horizontal ? row : row + i;
            const c = horizontal ? col + i : col;

            if (grid[r][c] !== '') {
                if (grid[r][c] !== word[i]) {
                    if (!this.isPartOfIntersectingWord(grid, r, c, word[i], horizontal)) {
                        return false;
                    }
                }
                hasIntersection = true;
            }

            // Check surrounding cells
            if (grid[r][c] === '') {
                if (horizontal) {
                    if (r > 0 && grid[r-1][c] !== '') return false;
                    if (r < this.GRID_SIZE-1 && grid[r+1][c] !== '') return false;
                } else {
                    if (c > 0 && grid[r][c-1] !== '') return false;
                    if (c < this.GRID_SIZE-1 && grid[r][c+1] !== '') return false;
                }
            }
        }

        // Check word boundaries
        if (horizontal) {
            if (col > 0 && grid[row][col-1] !== '') return false;
            if (col + word.length < this.GRID_SIZE && grid[row][col + word.length] !== '') return false;
        } else {
            if (row > 0 && grid[row-1][col] !== '') return false;
            if (row + word.length < this.GRID_SIZE && grid[row + word.length][col] !== '') return false;
        }

        return this.placedWords.length === 0 || hasIntersection;
    }

    isPartOfIntersectingWord(grid, row, col, letter, horizontal) {
        if (horizontal) {
            for (let i = col - 1; i >= 0; i--) {
                if (grid[row][i] === '') break;
                if (grid[row][i] === letter) return true;
            }
            for (let i = col + 1; i < this.GRID_SIZE; i++) {
                if (grid[row][i] === '') break;
                if (grid[row][i] === letter) return true;
            }
        } else {
            for (let i = row - 1; i >= 0; i--) {
                if (grid[i][col] === '') break;
                if (grid[i][col] === letter) return true;
            }
            for (let i = row + 1; i < this.GRID_SIZE; i++) {
                if (grid[i][col] === '') break;
                if (grid[i][col] === letter) return true;
            }
        }
        return false;
    }

    placeWord(grid, wordData, row, col, horizontal) {
        const word = wordData.word;
        const placedWord = {
            wordData: wordData,
            word: word,
            row: row,
            col: col,
            horizontal: horizontal,
            number: this.placedWords.length + 1
        };

        for (let i = 0; i < word.length; i++) {
            const r = horizontal ? row : row + i;
            const c = horizontal ? col + i : col;
            grid[r][c] = word[i];
        }

        this.placedWords.push(placedWord);
    }

  removeWord(grid, placedWord) {
        const {word, row, col, horizontal} = placedWord;
        for (let i = 0; i < word.length; i++) {
            const r = horizontal ? row : row + i;
            const c = horizontal ? col + i : col;
            grid[r][c] = '';
        }
    }

    backtrack(grid, words, wordToPlace) {
        const currentWordIndex = words.indexOf(wordToPlace);

        for (let i = currentWordIndex - 1; i >= 0; i--) {
            const prevWord = this.placedWords[i];
            if (!prevWord) continue;

            this.removeWord(grid, prevWord);
            this.placedWords.splice(i, 1);

            if (this.tryPlaceWord(grid, wordToPlace)) {
                return true;
            }

            this.placeWord(grid, prevWord.wordData, prevWord.row, prevWord.col, prevWord.horizontal);
        }

        return false;
    }

    displayGrid(grid) {
        const crosswordGrid = document.getElementById('crossword-grid');
        crosswordGrid.innerHTML = '';

        document.documentElement.style.setProperty('--grid-size', this.GRID_SIZE);
        crosswordGrid.style.gridTemplateColumns = `repeat(${this.GRID_SIZE}, var(--cell-size))`;

        for (let row = 0; row < this.GRID_SIZE; row++) {
            for (let col = 0; col < this.GRID_SIZE; col++) {
                const cellDiv = document.createElement('div');
                cellDiv.className = 'cell';

                if (grid[row][col] === '◼') {
                    cellDiv.classList.add('black-cell');
                } else if (grid[row][col]) {
                    cellDiv.classList.add('filled');
                    cellDiv.textContent = grid[row][col];

                    const placedWord = this.placedWords.find(word => {
                        const [wordRow, wordCol] = word.horizontal
                            ? [word.row, word.col + (col - word.col)]
                            : [word.row + (row - word.row), word.col];
                        return wordRow === row && wordCol === col;
                    });

                    if (placedWord && (placedWord.horizontal ? col === placedWord.col : row === placedWord.row)) {
                        const numberSpan = document.createElement('span');
                        numberSpan.className = 'cell-number';
                        numberSpan.textContent = placedWord.number;
                        cellDiv.insertBefore(numberSpan, cellDiv.firstChild);
                    }
                }

                crosswordGrid.appendChild(cellDiv);
            }
        }
    }

    displayClues() {
        const cluesContainer = document.getElementById('clues');
        cluesContainer.innerHTML = '<h2>Clues</h2>';

        const acrossClues = [];
        const downClues = [];

        const numberMap = new Map();
        this.placedWords.forEach((word, index) => {
            const key = `${word.row},${word.col}`;
            if (!numberMap.has(key)) {
                numberMap.set(key, index + 1);
            }
            const number = numberMap.get(key);
            const clueText = `${number}. ${word.wordData.clue}`;

            if (word.horizontal) {
                acrossClues.push(clueText);
            } else {
                downClues.push(clueText);
            }
        });

        if (acrossClues.length > 0) {
            const acrossCluesElement = document.createElement('div');
            acrossCluesElement.innerHTML = '<h3>Across</h3><ul>' +
                acrossClues.map(clue => `<li>${clue}</li>`).join('') + '</ul>';
            cluesContainer.appendChild(acrossCluesElement);
        }

        if (downClues.length > 0) {
            const downCluesElement = document.createElement('div');
            downCluesElement.innerHTML = '<h3>Down</h3><ul>' +
                downClues.map(clue => `<li>${clue}</li>`).join('') + '</ul>';
            cluesContainer.appendChild(downCluesElement);
        }
    }

  changeVersion(direction) {
        this.currentVersion = (this.currentVersion + direction + VERSIONS.length) % VERSIONS.length;
        this.displayCurrentVersion();
    }

    displayCurrentVersion() {
        const cells = document.querySelectorAll('#crossword-grid .cell');

        cells.forEach((cell, index) => {
            const row = Math.floor(index / this.GRID_SIZE);
            const col = index % this.GRID_SIZE;

            // Reset cell
            cell.textContent = '';
            cell.classList.remove('first-letter', 'empty-word', 'black-cell', 'filled');

            if (this.grid[row][col] === '◼') {
                cell.classList.add('black-cell');
                return;
            }

            if (this.grid[row][col] && this.grid[row][col] !== '◼') {
                switch(VERSIONS[this.currentVersion]) {
                    case 'full':
                        cell.textContent = this.grid[row][col];
                        cell.classList.add('filled');
                        break;
                    case 'firstLetter':
                        const firstLetterPlacedWord = this.placedWords.find(word => {
                            const [wordRow, wordCol] = word.horizontal
                                ? [word.row, word.col]
                                : [word.row, word.col];
                            return wordRow === row && wordCol === col;
                        });

                        if (firstLetterPlacedWord) {
                            cell.textContent = this.grid[row][col][0];
                            cell.classList.add('first-letter', 'filled');
                        }
                        break;
                    case 'empty':
                        cell.classList.add('empty-word');
                        break;
                }
            }

            // Add numbers to cells
            const placedWord = this.placedWords.find(word => {
                const [wordRow, wordCol] = word.horizontal
                    ? [word.row, word.col]
                    : [word.row, word.col];
                return wordRow === row && wordCol === col;
            });

            if (placedWord) {
                const numberSpan = document.createElement('span');
                numberSpan.className = 'cell-number';
                numberSpan.textContent = placedWord.number;
                cell.insertBefore(numberSpan, cell.firstChild);
            }
        });

        const versionIndicator = document.querySelector('.version-indicator');
        if (versionIndicator) {
            versionIndicator.textContent = `Version ${this.currentVersion + 1}`;
        }
    }

    validatePersonalPuzzle(grid, placedWords) {
        const warnings = [];

        if (placedWords.length < this.wordData.length) {
            warnings.push(`Could only fit ${placedWords.length} out of ${this.wordData.length} words. Try increasing the grid size or removing some longer words.`);
        }

        const filledCells = grid.flat().filter(cell => cell !== '').length;
        const totalCells = this.GRID_SIZE * this.GRID_SIZE;
        const fillPercentage = (filledCells / totalCells) * 100;

        if (fillPercentage < 20) {
            warnings.push(`The puzzle looks a bit empty. You might want to try a smaller grid size or add more words.`);
        }

        const longestWord = Math.max(...this.wordData.map(w => w.word.length));
        if (longestWord > this.GRID_SIZE - 2) {
            warnings.push(`Some words might be too long for this grid size. Consider increasing the grid size or using shorter words.`);
        }

        return warnings;
    }

    displayValidationWarnings(warnings) {
        const warningsContainer = this.getWarningsContainer();
        warningsContainer.innerHTML = '';

        if (warnings.length > 0) {
            warnings.forEach(warning => {
                const warningElement = document.createElement('div');
                warningElement.className = 'warning';
                warningElement.textContent = warning;
                warningsContainer.appendChild(warningElement);
            });
        }
    }

    displayError(message) {
        const warningsContainer = this.getWarningsContainer();
        warningsContainer.innerHTML = `<div class="error">${message}</div>`;
    }

    getWarningsContainer() {
        let warningsContainer = document.getElementById('warnings');
        if (!warningsContainer) {
            warningsContainer = document.createElement('div');
            warningsContainer.id = 'warnings';
            warningsContainer.className = 'warnings-container';
            document.querySelector('.puzzle-container').appendChild(warningsContainer);
        }
        return warningsContainer;
    }

  isPartOfWord(row, col) {
    return this.placedWords.some(word => {
        if (word.horizontal) {
            return row === word.row && 
                   col >= word.col && 
                   col < word.col + word.wordData.word.length;
        } else {
            return col === word.col && 
                   row >= word.row && 
                   row < word.row + word.wordData.word.length;
        }
    });
}


async saveCrossword() {
  
    if (!this.grid || !this.placedWords.length) {
        this.showFeedback("Please generate a crossword first", true);
        return;
    }
    const puzzleContainer = document.querySelector('.puzzle-container');
    if (!puzzleContainer) {
        this.showFeedback("Error: Puzzle container not found", true);
        return;
    }

    try {
        this.showFeedback("Processing puzzle...");
        
        const bounds = this.findCrosswordBounds();
        const exportContainer = document.createElement('div');
        exportContainer.style.position = 'absolute';
        exportContainer.style.left = '-9999px';
        exportContainer.style.top = '-9999px';
        exportContainer.style.backgroundColor = 'white';
        exportContainer.style.padding = '20px';
        document.body.appendChild(exportContainer);
        
        const croppedGrid = document.createElement('div');
        croppedGrid.id = 'export-grid';
        
        const width = bounds.right - bounds.left + 1;
        const height = bounds.bottom - bounds.top + 1;
        
        croppedGrid.style.display = 'grid';
        croppedGrid.style.gridTemplateColumns = `repeat(${width}, 30px)`;
        croppedGrid.style.gridTemplateRows = `repeat(${height}, 30px)`;
        croppedGrid.style.gap = '0px';
        croppedGrid.style.width = `${width * 30}px`;
        croppedGrid.style.height = `${height * 30}px`;
        
        for (let row = bounds.top; row <= bounds.bottom; row++) {
            for (let col = bounds.left; col <= bounds.right; col++) {
                const cell = document.createElement('div');
                cell.className = 'cell';
                cell.style.width = '30px';
                cell.style.height = '30px';
                cell.style.borderRadius = '0';
                cell.style.display = 'flex';
                cell.style.alignItems = 'center';
                cell.style.justifyContent = 'center';
                cell.style.position = 'relative';
                cell.style.backgroundColor = 'transparent';
                cell.style.cssText += 'border-radius: 0 !important;';
                
               if (this.isPartOfWord(row, col)) {
    cell.style.border = '1px solid black';
    cell.style.backgroundColor = '#FFFFFF'; // Add white background to cells part of words
}

if (this.grid[row][col] === '◼') {
    cell.style.backgroundColor = '#000000';
    cell.style.border = 'none'; // Fix the syntax error in border style
} else if (this.grid[row][col] && this.currentVersion !== 2) {
    cell.textContent = this.grid[row][col];
}

const placedWord = this.placedWords.find(word => {
    const [wordRow, wordCol] = word.horizontal
        ? [word.row, word.col]
        : [word.row, word.col];
    return wordRow === row && wordCol === col;
});
                
                if (placedWord) {
                    const numberSpan = document.createElement('span');
                    numberSpan.className = 'cell-number';
                    numberSpan.textContent = placedWord.number;
                    numberSpan.style.position = 'absolute';
                    numberSpan.style.top = '1px';
                    numberSpan.style.left = '1px';
                    numberSpan.style.fontSize = '10px';
                    cell.appendChild(numberSpan);
                }
                
                croppedGrid.appendChild(cell);
            }
        }
        
        exportContainer.appendChild(croppedGrid);
        
        const canvas = await html2canvas(croppedGrid, {
            scale: 2,
            backgroundColor: 'null',
            useCORS: true,
            width: width * 30,
            height: height * 30,
            
            onclone: (clonedDoc) => {
                const clonedGrid = clonedDoc.getElementById('export-grid');
                if (clonedGrid) {
                    clonedGrid.style.display = 'grid';
                    clonedGrid.style.gridTemplateColumns = `repeat(${width}, 30px)`;
                    clonedGrid.style.gridTemplateRows = `repeat(${height}, 30px)`;
                }
               ignoreElements: (element) => {
        // Ignore elements that cause errors
        return element.classList.contains('details-modal') || 
               element.classList.contains('predictive-search');
    }
            }
        });
        
        const base64Image = canvas.toDataURL('image/png');
        document.body.removeChild(exportContainer);
        
        // Save the image to the server
        const saveResponse = await fetch(`${baseURL}/save-crossword`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64Image })
        });
        
        const data = await saveResponse.json();
        console.log("Save response:", data);
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to save image');
        }

        // Store the crossword image URL in localStorage
        if (data.url) {
            localStorage.setItem('lastSavedCrosswordImage', data.url);
            // Update any existing editor instance with the new image URL
            if (window.crosswordEditor) {
                window.crosswordEditor.currentProduct = {
                    ...window.crosswordEditor.currentProduct,
                    crosswordImage: data.url
                };
            }
        }
        
        this.showFeedback("Image saved successfully!");
        
        try {
            const productsResponse = await fetch(`${baseURL}/products`);
            const products = await productsResponse.json();
            
            if (window.crosswordEditor) {
                // Pass both products and the newly saved image URL
                window.crosswordEditor.showProductSelection(products.products, data.url);
            }
        } catch (error) {
            console.error('Error fetching products:', error);
            this.showFeedback("Crossword saved, but failed to load products. Please try again.", true);
        }
        
    } catch (error) {
        console.error('Error:', error);
        this.showFeedback(error.message || "Failed to process puzzle", true);
    }
}

  // Add to CrosswordGenerator class
async validateImageForPrinting(imageData) {
  const { width, height } = imageData;
  const minDimension = 1000; // Minimum print resolution
  
  return {
    isValid: width >= minDimension && height >= minDimension,
    specs: { width, height }
  };
}

findCrosswordBounds() {
 
console.log('Grid state:', this.grid);
console.log('Placed words:', this.placedWords);
    if (!this.grid || !this.placedWords) {
        throw new Error("Grid or placed words not initialized");
    }

    let minRow = this.GRID_SIZE - 1, maxRow = 0;
    let minCol = this.GRID_SIZE - 1, maxCol = 0;
    
    const wordCells = new Set();
    this.placedWords.forEach(word => {
        if (!word?.wordData?.word) return;
        const length = word.wordData.word.length;
        for (let i = 0; i < length; i++) {
            const row = word.horizontal ? word.row : word.row + i;
            const col = word.horizontal ? word.col + i : word.col;
            wordCells.add(`${row},${col}`);
        }
    });
    
    // Add null check for grid cells
    for (let row = 0; row < this.GRID_SIZE; row++) {
        for (let col = 0; col < this.GRID_SIZE; col++) {
            if (wordCells.has(`${row},${col}`) || (this.grid[row]?.[col])) {
                minRow = Math.min(minRow, row);
                maxRow = Math.max(maxRow, row);
                minCol = Math.min(minCol, col);
                maxCol = Math.max(maxCol, col);
            }
        }
    }
    
    return { top: minRow, bottom: maxRow, left: minCol, right: maxCol, wordCells };
}

    showFeedback(message, isError = false) {
        const modal = document.getElementById('feedback-modal');
        const feedbackMessage = document.getElementById('feedback-message');
        
        if (!modal || !feedbackMessage) {
            console.error('Feedback modal elements not found');
            alert(message);
            return;
        }

        feedbackMessage.textContent = message;
        feedbackMessage.className = isError ? 'error-message' : 'success-message';
        modal.style.display = 'block';
        
        setTimeout(() => {
            modal.style.display = 'none';
        }, 3000);
    }
}

// Initialize after DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.crosswordGenerator = new CrosswordGenerator();
    window.crosswordGenerator.initializeControls();
});

// Export for module usage
window.CrosswordGenerator = CrosswordGenerator;

